#!/data/data/com.termux/files/usr/bin/bash
# Запускает сервер и туннель ngrok и перезапускает их, если упадут.
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null
mkdir -p data/logs
DOMAIN=$(tr -d ' \n\r' < data/domain.txt 2>/dev/null)
if [ -z "$DOMAIN" ]; then echo "Нет файла data/domain.txt с адресом ngrok"; exit 1; fi
pkill -f "node server.js" 2>/dev/null; pkill -f "ngrok http" 2>/dev/null
( while true; do node server.js >> data/logs/server.log 2>&1; sleep 5; done ) &
( while true; do termux-chroot "$HOME/ngrok" http --url="$DOMAIN" 8787 --log=stdout >> data/logs/ngrok.log 2>&1; sleep 15; done ) &
echo "Запущено. Адрес: https://$DOMAIN  Логи: $(pwd)/data/logs/"
wait
