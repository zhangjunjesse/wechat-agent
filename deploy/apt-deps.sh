#!/bin/bash
docker exec wechat-agent sh -c '
pkill -9 -f apt-get 2>/dev/null; pkill -9 -f "apt " 2>/dev/null; pkill -9 -f "apt/dpkg" 2>/dev/null; sleep 2
rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq 2>&1 | tail -1
apt-get install -y -qq --no-install-recommends libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 libxi6 libxtst6 2>&1 | tail -3
echo APT_OK
'
