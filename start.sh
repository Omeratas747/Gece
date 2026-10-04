#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
#  BOTU BAŞLATMA BETİĞİ
#  Bot bir hatayla kapanırsa 5 saniye sonra otomatik olarak yeniden başlar.
# ============================================================================

if [ ! -f .env ]; then
  echo "❌ .env dosyası bulunamadı. Önce: bash install.sh"
  exit 1
fi

# Termux'un arka planda uykuya geçip işlemi öldürmesini engelle (varsa)
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

while true; do
  echo "🚀 Bot başlatılıyor..."
  NODE_OPTIONS="--dns-result-order=ipv4first" node index.js
  echo "⚠️  Bot durdu / çöktü. 5 saniye içinde yeniden başlatılacak... (Ctrl+C ile durdurun)"
  sleep 5
done
