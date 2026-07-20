#!/usr/bin/env bash
# Matriz de testes geoblock a partir do host atual (Brutus).
# Camuflagem de cliente NÃO deve mudar blocked; só exit TCP FI muda.
set -u
FI_IP="65.21.146.77"
GEO="https://polymarket.com/api/geoblock"
OUT=/tmp/geoblock-matrix.txt
: > "$OUT"

row() {
  local name="$1" body="$2"
  local blocked country ip
  blocked=$(printf '%s' "$body" | sed -n 's/.*"blocked"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' | head -1)
  country=$(printf '%s' "$body" | sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  ip=$(printf '%s' "$body" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  printf '%-44s blocked=%-5s country=%-4s ip=%s\n' "$name" "${blocked:-?}" "${country:-?}" "${ip:-?}" | tee -a "$OUT"
  printf '  raw: %s\n' "$(printf '%s' "$body" | tr '\n' ' ' | head -c 240)" | tee -a "$OUT"
}

echo "===== A) Camuflagem de cliente (sem mudar exit TCP) ====="

row "01_direct_curl" "$(curl -sS --max-time 12 "$GEO" 2>&1 || true)"

row "02_X-Forwarded-For_FI" "$(curl -sS --max-time 12 \
  -H "X-Forwarded-For: $FI_IP" \
  -H "X-Real-IP: $FI_IP" \
  -H "CF-Connecting-IP: $FI_IP" \
  -H "True-Client-IP: $FI_IP" \
  -H "Forwarded: for=$FI_IP;proto=https" \
  "$GEO" 2>&1 || true)"

row "03_locale_fi_UA" "$(curl -sS --max-time 12 \
  -H "Accept-Language: fi-FI,fi;q=0.9,en;q=0.8" \
  -H "User-Agent: Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" \
  "$GEO" 2>&1 || true)"

row "04_all_headers_plus_locale" "$(curl -sS --max-time 12 \
  -H "X-Forwarded-For: $FI_IP, 127.0.0.1" \
  -H "X-Real-IP: $FI_IP" \
  -H "CF-Connecting-IP: $FI_IP" \
  -H "True-Client-IP: $FI_IP" \
  -H "X-Client-IP: $FI_IP" \
  -H "X-Originating-IP: $FI_IP" \
  -H "Forwarded: for=$FI_IP;proto=https;by=brutus" \
  -H "Accept-Language: fi-FI,fi;q=0.9" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "$GEO" 2>&1 || true)"

row "05_POST_geoblock" "$(curl -sS --max-time 12 -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"ip\":\"$FI_IP\",\"country\":\"FI\"}" \
  "$GEO" 2>&1 || true)"

row "06_http_cleartext_follow" "$(curl -sS --max-time 12 -L --http1.1 "http://polymarket.com/api/geoblock" 2>&1 || true)"

row "07_http2" "$(curl -sS --max-time 12 --http2 "$GEO" 2>&1 || true)"

if curl -6 -sS --max-time 8 -o /dev/null -w '%{http_code}' https://ifconfig.co 2>/dev/null | grep -qE '200|301|302'; then
  row "08_ipv6_direct" "$(curl -6 -sS --max-time 12 "$GEO" 2>&1 || true)"
else
  row "08_ipv6_direct" '{"blocked":"skipped-no-ipv6","ip":"n/a","country":"n/a"}'
fi

row "09_via_helsinki" "$(curl -sS --max-time 12 -H "Via: 1.1 helsinki.proxy.local" "$GEO" 2>&1 || true)"

row "10_cookie_geo_fi" "$(curl -sS --max-time 12 -H "Cookie: country=FI; locale=fi-FI; geo=FI" "$GEO" 2>&1 || true)"

echo
echo "===== B) Clientes alternativos ====="

if command -v python3 >/dev/null 2>&1; then
  row "11_python_urllib" "$(python3 - <<'PY' 2>&1 || true
import urllib.request
req=urllib.request.Request("https://polymarket.com/api/geoblock", headers={
  "X-Forwarded-For":"65.21.146.77",
  "Accept-Language":"fi-FI",
  "User-Agent":"Python-urllib/study",
})
print(urllib.request.urlopen(req, timeout=12).read().decode())
PY
)"
else
  row "11_python_urllib" '{"blocked":"no-python","ip":"n/a","country":"n/a"}'
fi

if command -v node >/dev/null 2>&1; then
  row "12_node_fetch" "$(node -e '
fetch("https://polymarket.com/api/geoblock",{headers:{
  "X-Forwarded-For":"65.21.146.77",
  "CF-Connecting-IP":"65.21.146.77",
  "Accept-Language":"fi-FI",
}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({blocked:"err",error:String(e)})))
' 2>&1 || true)"
else
  row "12_node_fetch" '{"blocked":"no-node","ip":"n/a","country":"n/a"}'
fi

if command -v wget >/dev/null 2>&1; then
  row "13_wget" "$(wget -qO- --timeout=12 --header="X-Forwarded-For: $FI_IP" "$GEO" 2>&1 || true)"
else
  row "13_wget" '{"blocked":"no-wget","ip":"n/a","country":"n/a"}'
fi

# openssl s_client + manual GET (ainda IP BR)
row "14_openssl_manual_get" "$(
  {
    printf 'GET /api/geoblock HTTP/1.1\r\nHost: polymarket.com\r\nX-Forwarded-For: %s\r\nAccept: application/json\r\nConnection: close\r\n\r\n' "$FI_IP"
  } | openssl s_client -connect polymarket.com:443 -servername polymarket.com -quiet 2>/dev/null \
    | tr -d '\r' | sed -n '/^{/,$p' | head -c 400
)"

echo
echo "===== C) DNS (contexto) ====="
(getent ahostsv4 polymarket.com 2>/dev/null || true) | head -5
(dig +short polymarket.com A 2>/dev/null || host polymarket.com 2>/dev/null || true) | head -5

echo
echo "===== D) Controle: exit TCP Giovanna FI (SSH SOCKS) ====="
pkill -f 'ssh .* -D 18080' 2>/dev/null || true
sleep 0.5
if ssh -o ConnectTimeout=12 -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N -D 18080 Giovanna 2>/tmp/socks-err; then
  sleep 1
  row "15_socks_giovanna_exit" "$(curl -sS --max-time 20 --socks5-hostname 127.0.0.1:18080 "$GEO" 2>&1 || true)"
  pkill -f 'ssh .* -D 18080' 2>/dev/null || true
else
  echo "socks setup failed:"; cat /tmp/socks-err 2>/dev/null || true
  row "15_socks_giovanna_exit" '{"blocked":"socks-fail","ip":"n/a","country":"n/a"}'
fi

echo
echo "===== RESUMO (só linhas blocked=) ====="
grep -E '^[^ ].*blocked=' "$OUT" || true
echo
echo "Arquivo: $OUT"
