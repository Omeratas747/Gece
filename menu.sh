#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
#  TERMUX YÖNETİM MENÜSÜ
#  Kullanım: bash menu.sh
#  32-bit dahil tüm Termux mimarilerinde çalışır (saf bash, ek paket gerekmez)
# ============================================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

PID_FILE="$DIR/bot.pid"
LOG_FILE="$DIR/bot.log"

is_running() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_bot() {
  if is_running; then
    echo "⚠️  Bot zaten çalışıyor (PID: $(cat "$PID_FILE"))."
    return
  fi
  if [ ! -f .env ]; then
    echo "❌ .env dosyası bulunamadı. Önce '1) Kurulum' veya '7) .env düzenle' seçeneğini kullanın."
    return
  fi
  if [ ! -d node_modules ]; then
    echo "❌ Paketler kurulu değil. Önce '1) Kurulum' seçeneğini çalıştırın."
    return
  fi
  # Android'in arka planda ağı/CPU'yu kısıtlayıp bağlantıyı koparmaması için
  # uyku kilidi al (Termux:API uygulaması + termux-api paketi gerekir).
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    echo "🔒 Uyku kilidi alındı (arka planda kesintisiz çalışması için)."
  else
    echo "⚠️  termux-wake-lock bulunamadı. Kurulum: pkg install termux-api"
    echo "    (ayrıca Play Store/F-Droid'den 'Termux:API' uygulamasını da kurmanız gerekir)"
    echo "    Aksi halde ekran kapanınca/Termux arka plana atılınca bot Discord'da"
    echo "    OFFLINE görünebilir, işlem PID olarak canlı kalsa bile."
  fi
  echo "🚀 Bot arka planda başlatılıyor..."
  # Bazı mobil ağlarda/Termux'ta bozuk IPv6 yönlendirmesi bağlantı zaman
  # aşımlarına sebep olabiliyor; Node'u önce IPv4 denemeye zorluyoruz.
  NODE_OPTIONS="--dns-result-order=ipv4first" nohup node index.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "✅ Bot başlatıldı. PID: $(cat "$PID_FILE")"
  else
    echo "❌ Bot başlatılamadı. '5) Logları görüntüle' ile hataya bakın."
  fi
}

stop_bot() {
  if ! is_running; then
    echo "ℹ️  Bot zaten çalışmıyor."
    rm -f "$PID_FILE"
    return
  fi
  PID=$(cat "$PID_FILE")
  kill "$PID" 2>/dev/null
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
  echo "🛑 Bot durduruldu."
}

restart_bot() {
  stop_bot
  sleep 1
  start_bot
}

show_status() {
  if is_running; then
    echo "🟢 Durum: ÇALIŞIYOR (PID: $(cat "$PID_FILE"))"
  else
    echo "🔴 Durum: ÇALIŞMIYOR"
  fi
}

run_install() {
  if [ -f install.sh ]; then
    bash install.sh
  else
    echo "❌ install.sh bulunamadı (bot dosyalarıyla aynı klasörde olmalı)."
  fi
}

edit_env() {
  if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "📄 .env, .env.example'dan oluşturuldu."
  fi
  if command -v nano >/dev/null 2>&1; then
    nano .env
  else
    vi .env
  fi
}

view_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "ℹ️  Henüz log dosyası yok (bot hiç başlatılmamış olabilir)."
    return
  fi
  read -r -p "Canlı izlemek ister misiniz? (e = canlı, h = son 50 satır): " ans
  if [ "$ans" = "e" ] || [ "$ans" = "E" ]; then
    echo "── Canlı log (menüye dönmek için Ctrl+C) ──"
    tail -f "$LOG_FILE"
    echo ""
    echo "── Canlı izleme durduruldu ──"
  else
    echo "── Son 50 log satırı ──"
    tail -n 50 "$LOG_FILE"
  fi
}

clear_logs() {
  : > "$LOG_FILE"
  echo "🧹 Log dosyası temizlendi."
}

list_servers() {
  local snapshot="$DIR/guilds.json"
  if [ ! -f "$snapshot" ]; then
    echo "ℹ️  Henüz sunucu bilgisi kaydedilmemiş. Botu en az bir kez başlatın (2)."
    return
  fi
  echo "── Botun bulunduğu sunucular (son bilinen durum) ──"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (data.length === 0) {
        console.log("Bot şu anda hiçbir sunucuda değil.");
      } else {
        data.forEach((g) => console.log(`• ${g.name}\n  ID: ${g.id}   Üye: ${g.memberCount ?? "?"}`));
        console.log(`\nToplam: ${data.length} sunucu`);
      }
    ' "$snapshot"
  else
    cat "$snapshot"
  fi
  if is_running; then
    echo "(Bot şu anda çalışıyor, bu liste güncel.)"
  else
    echo "(Bot şu anda kapalı, bu liste son çalıştığındaki durumu gösteriyor.)"
  fi
}

list_credits() {
  local db="$DIR/bot.db"
  if [ ! -f "$db" ]; then
    echo "ℹ️  Veritabanı henüz oluşmamış. Botu en az bir kez başlatın (2)."
    return
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "❌ sqlite3 komutu bulunamadı. Kurmak için: pkg install sqlite"
    return
  fi
  echo "── Kullanıcı kredileri ──"
  local count
  count=$(sqlite3 "$db" "SELECT COUNT(*) FROM users;")
  if [ "$count" = "0" ]; then
    echo "Henüz hiçbir kullanıcının kredi kaydı yok."
    return
  fi
  sqlite3 -header -column "$db" "SELECT user_id AS Kullanici_ID, credits AS Kredi FROM users ORDER BY credits DESC;"
}

print_menu() {
  clear
  echo "============================================"
  echo "   🤖 DISCORD BOT YÖNETİM MENÜSÜ (Termux)"
  echo "============================================"
  show_status
  echo "--------------------------------------------"
  echo " 1) Kurulumu çalıştır / güncelle"
  echo " 2) Botu başlat"
  echo " 3) Botu durdur"
  echo " 4) Botu yeniden başlat"
  echo " 5) Logları görüntüle"
  echo " 6) Logları temizle"
  echo " 7) .env dosyasını düzenle"
  echo " 8) Durumu göster"
  echo " 9) Sunucuları listele (hangi sunucularda, kaç üye)"
  echo "10) Kullanıcı kredilerini listele (kimde ne kadar var)"
  echo "11) Çıkış (bot arka planda çalışmaya devam eder)"
  echo "============================================"
}

while true; do
  print_menu
  read -r -p "Seçiminiz [1-11]: " choice
  echo ""
  case "$choice" in
    1) run_install ;;
    2) start_bot ;;
    3) stop_bot ;;
    4) restart_bot ;;
    5) view_logs ;;
    6) clear_logs ;;
    7) edit_env ;;
    8) show_status ;;
    9) list_servers ;;
    10) list_credits ;;
    11)
      echo "👋 Menüden çıkılıyor. Bot arka planda çalışmaya devam ediyor."
      echo "   Durdurmak için menüyü tekrar açıp (bash menu.sh) 3'ü seçin."
      break
      ;;
    *) echo "❌ Geçersiz seçim, 1-11 arası bir sayı girin." ;;
  esac
  echo ""
  read -r -p "Devam etmek için Enter'a basın..." _
done
