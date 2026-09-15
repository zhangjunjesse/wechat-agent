const c = require('@sparticuz/chromium').default;
c.executablePath().then(async (p) => {
  console.log('BIN:', p);
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync(p, ['--headless=new','--disable-gpu','--no-sandbox','--dump-dom','file:///tmp/test-poster.html'], { encoding: 'utf8', timeout: 30000 });
    console.log('DUMP_OK len=', out.length);
    const m = /<title>H=(\d+)/.exec(out);
    console.log('H_MATCH=', m ? m[1] : 'none');
  } catch (e) {
    console.log('DUMP_ERR out=', String(e.stdout || '').slice(0, 300));
    console.log('DUMP_ERR err=', String(e.stderr || '').slice(0, 300));
  }
});
