#!/bin/bash
docker exec wechat-agent sh -c 'cd /app && node -e "
const c = require(\"@sparticuz/chromium\").default;
c.executablePath().then(async (p) => {
  console.log(\"EXEC:\", p);
  try {
    const fonts = await c.fonts();
    console.log(\"FONTS:\", JSON.stringify(fonts.slice(0, 5)));
    console.log(\"FONTS_DIRS:\", JSON.stringify([...new Set(fonts.map(f => require(\"path\").dirname(f)))].slice(0, 3)));
  } catch (e) { console.log(\"FONTS_ERR:\", e.message); }
});
"'
