#!/bin/bash
docker exec wechat-agent sh -c '
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq --no-install-recommends fonts-noto-cjk 2>&1 | tail -2
fc-list 2>/dev/null | grep -i -E "cjk|noto" | head -3 || ls /usr/share/fonts 2>/dev/null
'
docker commit wechat-agent wechat-agent:chromium
echo COMMIT_OK
