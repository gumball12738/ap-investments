export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // POST → AI portfolio analysis
  if (req.method === 'POST') {
    try {
      const { portfolio } = req.body;
      if (!portfolio) return res.status(400).json({ error: 'portfolio required' });
      const GROQ = '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';
      const prompt = `You are an elite investment analyst. Respond ONLY with valid JSON, no markdown. Portfolio: ${portfolio}\nJSON: {"summary":"...","style":"...","usExposure":"...","techExposure":"...","riskLevel":"Low|Medium|High|Very High","pros":["..."],"cons":["..."],"overlaps":[{"pair":"...","severity":"High|Medium|Low","note":"..."}],"improvements":[{"action":"...","reason":"..."}],"toRemove":[{"ticker":"...","reason":"..."}],"toAdd":[{"ticker":"...","name":"...","reason":"...","type":"ETF|Stock"}],"suggestedWeights":[{"ticker":"...","current":0,"suggested":0,"reason":"..."}],"verdict":"..."}`;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.3, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      const raw = d.choices?.[0]?.message?.content || '';
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('No JSON from AI');
      return res.status(200).json(JSON.parse(m[0]));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const { type } = req.query;

  // GET quote → live prices for banner
  if (type === 'quote') {
    try {
      const syms = (req.query.symbols || '^GSPC,^IXIC,EQGB.L,VUAG.L,SEMI.L,VWRP.L,JREM.L').split(',').map(s => s.trim());
      const results = await Promise.all(syms.map(async sym => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, { headers: H });
          if (!r.ok) return null;
          const d = await r.json();
          const result = d?.chart?.result?.[0];
          const meta = result?.meta;
          if (!meta) return null;
          const price = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose || meta.previousClose;
          // Get last two daily closes to compute change if meta doesn't have it
          const closes = result?.indicators?.quote?.[0]?.close || [];
          const validCloses = closes.filter(v => v != null);
          let changePct = null;
          if (price && prev) {
            changePct = (price - prev) / prev * 100;
          } else if (validCloses.length >= 2) {
            const last = validCloses[validCloses.length - 1];
            const prev2 = validCloses[validCloses.length - 2];
            changePct = (last - prev2) / prev2 * 100;
          }
          return {
            symbol: sym,
            name: meta.longName || meta.shortName || sym,
            price,
            changePct,
            currency: meta.currency
          };
        } catch { return null; }
      }));
      return res.status(200).json(results.filter(Boolean));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // GET chart → OHLC points
  if (type === 'chart') {
    const { ticker, range } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const RANGES = { '1d': ['15m','5d'], '1wk': ['30m','5d'], '1mo': ['1d','1mo'], '1y': ['1wk','1y'], '5y': ['1mo','5y'] };
    const [interval, r] = RANGES[range] || RANGES['1mo'];
    try {
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${r}&includePrePost=false`, { headers: H });
      if (!resp.ok) return res.status(resp.status).json({ error: `Yahoo ${resp.status}` });
      const d = await resp.json();
      const result = d?.chart?.result?.[0];
      if (!result) return res.status(404).json({ error: `No data for ${ticker}` });
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      let points = ts.map((t, i) => ({ t: t * 1000, v: closes[i] != null ? +closes[i].toFixed(4) : null })).filter(p => p.v != null);
      if (range === '1d' && points.length > 0) {
        const lastDate = new Date(points[points.length - 1].t).toDateString();
        const sess = points.filter(p => new Date(p.t).toDateString() === lastDate);
        if (sess.length >= 3) points = sess;
      }
      return res.status(200).json({ symbol: ticker, name: result.meta?.longName || ticker, currency: result.meta?.currency || 'USD', points });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // GET search → ticker search
  if (type === 'search') {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0&enableFuzzyQuery=true`, { headers: H });
      const d = await r.json();
      return res.status(200).json((d.quotes || []).filter(q => ['EQUITY','ETF','MUTUALFUND','INDEX'].includes(q.quoteType)).slice(0,12).map(q => ({ symbol: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchDisp || q.exchange, type: q.quoteType })));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // GET news
  if (type === 'news') {
    const tickers = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 8);
    if (!tickers.length) return res.status(400).json({ error: 'tickers required' });
    try {
      const results = await Promise.all(tickers.map(async ticker => {
        try {
          const [pr, nr] = await Promise.all([
            fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`, { headers: H }),
            fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=4`, { headers: H })
          ]);
          const pd = await pr.json(), nd = await nr.json();
          const meta = pd?.chart?.result?.[0]?.meta || {};
          return { ticker, name: meta.longName || meta.shortName || ticker, currentPrice: meta.regularMarketPrice, changePct: meta.regularMarketChangePercent, currency: meta.currency, articles: (nd?.news || []).slice(0,3).map(a => ({ title: a.title, publisher: a.publisher, link: a.link, time: a.providerPublishTime })) };
        } catch { return { ticker, error: 'Failed' }; }
      }));
      return res.status(200).json(results);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // GET yahoo → annual returns for compare tab
  if (type === 'yahoo') {
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=10y`, { headers: H });
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return res.status(404).json({ error: `No data for ${ticker}` });
      const ts = result.timestamp || [], closes = result.indicators?.quote?.[0]?.close || [];
      const byYear = {};
      ts.forEach((t, i) => { if (closes[i] == null) return; const yr = new Date(t*1000).getFullYear(); if (!byYear[yr]) byYear[yr] = { first: closes[i], last: closes[i] }; byYear[yr].last = closes[i]; });
      const curYear = new Date().getFullYear();
      const years = Array.from({length:10},(_,i) => curYear-10+i);
      return res.status(200).json({ ticker, name: result.meta?.longName || ticker, currency: result.meta?.currency, annualReturns: years.map(yr => { const y = byYear[yr]; return y ? +((y.last-y.first)/y.first).toFixed(4) : null; }), years });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Invalid type' });
}
