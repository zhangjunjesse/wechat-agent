p='/etc/caddy/Caddyfile'
s=open(p, encoding='utf-8').read()
s=s.replace('    handle /wechat-agent* {', '    handle_path /wechat-agent* {')
open(p,'w',encoding='utf-8').write(s)
print('ok')
