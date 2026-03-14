const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REWARDS_CONTRACT = '0xf7cD89BE08Af4D4D6B1522852ceD49FC10169f64';
const SPONSORED_TOPIC = '0xa0e1f8e6fb6dd49d885fabbf89adb64c0ef2b16b2786c92d6851742572fb1d14';
const WITHDRAWN_TOPIC = '0xb607e1cd434478843932237c1441e30dade0dd0b82ec588670a1d43dea0599de';

const RPCS = [
  { hostname: 'polygon.gateway.tenderly.co', path: '/' },
  { hostname: 'polygon-bor-rpc.publicnode.com', path: '/' },
];

let sponsorCache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_FILE = path.join(__dirname, 'sponsor-cache.json');

function rpcCall(body, rpcIdx = 0) {
  const rpc = RPCS[rpcIdx] || RPCS[0];
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: rpc.hostname, path: rpc.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function rpcWithFallback(body) {
  for (let i = 0; i < RPCS.length; i++) {
    try {
      const res = await rpcCall(body, i);
      if (!res.error) return res;
      // If pruned, try next RPC
      if (res.error.message && res.error.message.includes('pruned')) {
        continue;
      }
      return res;
    } catch (e) {
      if (i === RPCS.length - 1) throw e;
    }
  }
  throw new Error('All RPCs failed');
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function proxyRequest(targetUrl, res) {
  https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  }).on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
}

function parseSponsoredLog(log) {
  const sponsor = '0x' + log.topics[2].slice(26).toLowerCase();
  const marketId = log.topics[1];
  const data = log.data.slice(2);
  const amount = parseInt(data.slice(0, 64), 16) / 1e6;
  const startTime = parseInt(data.slice(64, 128), 16);
  const endTime = parseInt(data.slice(128, 192), 16);
  return { sponsor, marketId, amount, startTime, endTime, txHash: log.transactionHash };
}

function parseWithdrawnLog(log) {
  const sponsor = '0x' + log.topics[2].slice(26).toLowerCase();
  const marketId = log.topics[1];
  const data = log.data.slice(2);
  return {
    sponsor, marketId,
    returnedAmount: parseInt(data.slice(0, 64), 16) / 1e6,
    consumedAmount: parseInt(data.slice(64, 128), 16) / 1e6,
    isEarly: parseInt(data.slice(128, 192), 16) === 1
  };
}

async function fetchLogsChunked(topic, startBlock, endBlock, chunkSize) {
  const allLogs = [];
  for (let from = startBlock; from <= endBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, endBlock);
    try {
      const res = await rpcWithFallback({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ address: REWARDS_CONTRACT, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [topic] }]
      });
      if (res.result && Array.isArray(res.result)) {
        allLogs.push(...res.result);
      } else if (res.error) {
        if (res.error.message && res.error.message.includes('pruned')) {
          // Skip to a more recent block
          from = from + chunkSize * 3;
          continue;
        }
      }
    } catch (e) {
      console.error(`  Log fetch error at ${from}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return allLogs;
}

async function scanChain() {
  const bn = await rpcWithFallback({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  const currentBlock = parseInt(bn.result, 16);
  console.log('Current block:', currentBlock);

  // Scan full contract history - Tenderly supports archive data with large ranges
  const startBlock = currentBlock - 1500000; // ~35 days, covers full contract life

  console.log(`Scanning blocks ${startBlock} to ${currentBlock} (${currentBlock - startBlock} blocks)...`);

  // Fetch sponsored events with 100K block chunks (Tenderly handles this)
  const sponsoredLogs = await fetchLogsChunked(SPONSORED_TOPIC, startBlock, currentBlock, 100000);
  console.log(`Found ${sponsoredLogs.length} Sponsored events`);

  // Fetch withdrawn events
  const withdrawnLogs = await fetchLogsChunked(WITHDRAWN_TOPIC, startBlock, currentBlock, 100000);
  console.log(`Found ${withdrawnLogs.length} Withdrawn events`);

  return { sponsoredLogs, withdrawnLogs };
}

async function buildFullSponsorData() {
  if (sponsorCache && Date.now() - cacheTime < CACHE_TTL) {
    return sponsorCache;
  }

  // Try loading from disk cache first
  if (!sponsorCache) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (cached && cached.topSponsors && cached.topSponsors.length > 100) {
        console.log(`Loaded ${cached.topSponsors.length} sponsors from disk cache`);
        sponsorCache = cached;
        cacheTime = Date.now();
        // Refresh in background
        setTimeout(() => { cacheTime = 0; buildFullSponsorData().catch(() => {}); }, 5000);
        return sponsorCache;
      }
    } catch (e) { /* no cache file */ }
  }

  console.log('Building full sponsor data...');
  const allSponsors = new Map();

  // Get betmoar data
  let betmoarData = {};
  try {
    betmoarData = await httpsGet('https://www.betmoar.fun/api/sponsored-rewards');
    console.log('Betmoar: loaded');

    // Seed with betmoar top sponsors (authoritative data)
    for (const s of (betmoarData.topSponsors || [])) {
      allSponsors.set(s.sponsor.toLowerCase(), { ...s, sponsor: s.sponsor.toLowerCase() });
    }

    // Aggregate from other arrays
    for (const entry of [...(betmoarData.active || []), ...(betmoarData.recent || []), ...(betmoarData.recentWithdrawals || [])]) {
      const addr = (entry.sponsor || '').toLowerCase();
      if (!addr) continue;
      if (!allSponsors.has(addr)) {
        allSponsors.set(addr, {
          sponsor: addr, event_count: 0, unique_markets: 0,
          total_amount_usdc: 0, first_seen: entry.block_timestamp,
          last_seen: entry.block_timestamp, withdrawn_count: 0,
          total_returned_usdc: 0, total_consumed_usdc: 0, net_amount_usdc: 0,
          _markets: new Set()
        });
      }
      const s = allSponsors.get(addr);
      if (!s._markets) s._markets = new Set();
      if (entry.market_id) s._markets.add(entry.market_id);
      if (entry.amount_usdc) { s.total_amount_usdc += entry.amount_usdc; s.event_count++; }
      if (entry.consumed_usdc != null && !entry.amount_usdc) {
        s.total_consumed_usdc += entry.consumed_usdc || 0;
        s.total_returned_usdc += entry.returned_usdc || 0;
        s.withdrawn_count++;
      }
      if (entry.block_timestamp) {
        if (!s.first_seen || entry.block_timestamp < s.first_seen) s.first_seen = entry.block_timestamp;
        if (!s.last_seen || entry.block_timestamp > s.last_seen) s.last_seen = entry.block_timestamp;
      }
    }
    console.log(`Betmoar aggregation: ${allSponsors.size} sponsors`);
  } catch (e) {
    console.error('Betmoar failed:', e.message);
  }

  // Scan blockchain for additional sponsors
  try {
    const { sponsoredLogs, withdrawnLogs } = await scanChain();

    // Build a per-sponsor, per-market sponsorship tracker from chain events
    // so we can calculate consumed in real-time for active/non-withdrawn sponsorships
    const sponsorships = new Map(); // key: sponsor+marketId -> { amount, startTime, endTime, withdrawn, ... }

    for (const log of sponsoredLogs) {
      const event = parseSponsoredLog(log);
      const key = event.sponsor + '_' + event.marketId;
      sponsorships.set(key, {
        ...event,
        withdrawn: false,
        withdrawnConsumed: 0,
        withdrawnReturned: 0
      });
    }

    // Mark withdrawn sponsorships with actual consumed/returned values
    for (const log of withdrawnLogs) {
      const event = parseWithdrawnLog(log);
      const key = event.sponsor + '_' + event.marketId;
      if (sponsorships.has(key)) {
        const sp = sponsorships.get(key);
        sp.withdrawn = true;
        sp.withdrawnConsumed = event.consumedAmount;
        sp.withdrawnReturned = event.returnedAmount;
      }
    }

    // Now aggregate per sponsor with real-time consumed calculation
    const nowSec = Math.floor(Date.now() / 1000);

    // Track which addresses came from betmoar to avoid double counting amounts
    const betmoarAddrs = new Set(
      (betmoarData.topSponsors || []).map(s => s.sponsor.toLowerCase())
    );

    for (const [, sp] of sponsorships) {
      if (!allSponsors.has(sp.sponsor)) {
        allSponsors.set(sp.sponsor, {
          sponsor: sp.sponsor, event_count: 0, unique_markets: 0,
          total_amount_usdc: 0, first_seen: null, last_seen: null,
          withdrawn_count: 0, total_returned_usdc: 0, total_consumed_usdc: 0,
          net_amount_usdc: 0, _markets: new Set()
        });
      }

      const s = allSponsors.get(sp.sponsor);
      if (!s._markets) s._markets = new Set();
      s._markets.add(sp.marketId);

      // Only add amounts if not already counted from betmoar's topSponsors
      if (!betmoarAddrs.has(sp.sponsor)) {
        s.event_count++;
        s.total_amount_usdc += sp.amount;

        if (sp.withdrawn) {
          // Use actual onchain values
          s.withdrawn_count++;
          s.total_consumed_usdc += sp.withdrawnConsumed;
          s.total_returned_usdc += sp.withdrawnReturned;
        } else {
          // Calculate consumed in real-time based on elapsed time and rate
          const durationSec = sp.endTime - sp.startTime;
          if (durationSec > 0) {
            const ratePerSec = sp.amount / durationSec;
            const elapsedSec = Math.min(nowSec, sp.endTime) - sp.startTime;
            const elapsed = Math.max(0, elapsedSec);
            const consumed = Math.min(sp.amount, ratePerSec * elapsed);
            s.total_consumed_usdc += consumed;
            // If sponsorship has fully expired, returned = 0
            // If still active, returned is what's left (but not yet claimable)
            if (nowSec >= sp.endTime) {
              // Fully expired, all consumed (no refund since it ran to completion)
              // consumed already = amount in this case
            }
          }
        }
      }

      const ts = new Date(sp.startTime * 1000).toISOString();
      if (!s.first_seen || ts < s.first_seen) s.first_seen = ts;
      if (!s.last_seen || ts > s.last_seen) s.last_seen = ts;
    }

    console.log(`After chain scan: ${allSponsors.size} sponsors`);
  } catch (e) {
    console.error('Chain scan failed:', e.message, '- using betmoar data only');
  }

  // Finalize
  for (const [, s] of allSponsors) {
    if (s._markets) { s.unique_markets = Math.max(s.unique_markets || 0, s._markets.size); delete s._markets; }
    // For chain-scanned sponsors, returned = total_funded - consumed (for non-withdrawn)
    // For betmoar sponsors, returned is already set correctly
    s.total_returned_usdc = s.total_returned_usdc || 0;
    s.net_amount_usdc = s.total_consumed_usdc || 0; // net spent = what actually went to LPs
  }

  const sponsorList = [...allSponsors.values()]
    .filter(s => s.total_amount_usdc > 0)
    .sort((a, b) => b.total_amount_usdc - a.total_amount_usdc);

  console.log(`Final: ${sponsorList.length} unique sponsors`);

  const result = {
    overall: {
      ...(betmoarData.overall || {}),
      unique_sponsors_loaded: sponsorList.length
    },
    topSponsors: sponsorList,
    active: betmoarData.active || [],
    recent: betmoarData.recent || [],
    recentWithdrawals: betmoarData.recentWithdrawals || [],
    daily: betmoarData.daily || []
  };

  sponsorCache = result;
  cacheTime = Date.now();

  // Save to disk
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(result)); } catch (e) { /* ok */ }

  return result;
}

// Pre-warm on startup - store the promise so API requests can await it
let warmupPromise = null;
console.log('Starting server and warming cache...');
warmupPromise = buildFullSponsorData()
  .then(d => { console.log(`Cache ready: ${d.topSponsors.length} sponsors`); return d; })
  .catch(e => { console.error('Cache warm failed:', e.message); return null; });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/sponsored-rewards') {
    try {
      // Wait for initial warmup if still in progress
      if (warmupPromise) {
        await warmupPromise;
        warmupPromise = null;
      }
      const data = await buildFullSponsorData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/profile') {
    const addr = url.searchParams.get('address');
    proxyRequest(`https://polymarket.com/api/profile/userData?address=${addr}`, res);
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
