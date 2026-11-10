#!/bin/bash
# Раздача плагина Loki с этого компьютера (для разработки, пока плагин не на GitHub).
# Остановить: Ctrl+C

cd "$(dirname "$0")" || exit 1

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -z "$IP" ]; then
  echo "Не удалось определить IP в локальной сети. Mac подключён к Wi-Fi?"
  exit 1
fi

if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт 8000 уже занят (возможно, сервер уже запущен в другом окне)."
  echo "Остановить:  kill \$(lsof -t -iTCP:8000 -sTCP:LISTEN)"
  exit 1
fi

echo "────────────────────────────────────────────────────────"
echo " Плагин для Lampa:   http://$IP:8000/loki.js"
echo "────────────────────────────────────────────────────────"
echo " Остановить: Ctrl+C"
echo

python3 -m http.server 8000
