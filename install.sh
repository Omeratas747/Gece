#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
#  TERMUX OTOMATİK KURULUM BETİĞİ (32-bit / armv7 dahil tüm mimariler)
#  Kullanım: bash install.sh
# ============================================================================
set -e

echo "🔄 Termux depoları güncelleniyor..."
pkg update -y
pkg upgrade -y

echo "📦 Gerekli sistem paketleri kuruluyor (Node.js, derleyici araçları)..."
# better-sqlite3 gibi native modüller 32-bit cihazda hazır (prebuilt) binary
# bulamaz ve kaynaktan derlenir; bunun için python/clang/make/pkg-config gerekir.
pkg install -y nodejs-lts python clang make pkg-config git sqlite termux-api

echo "🟢 Node sürümü: $(node -v)"
echo "🟢 npm sürümü: $(npm -v)"

if [ ! -f package.json ]; then
  echo "📄 package.json bulunamadı, oluşturuluyor..."
  npm init -y >/dev/null
fi

echo "📦 npm bağımlılıkları kuruluyor (discord.js, better-sqlite3, dotenv)..."
echo "   (better-sqlite3 bu cihaz için kaynaktan derlenecek, birkaç dakika sürebilir)"
npm install discord.js better-sqlite3 dotenv --build-from-source=better-sqlite3

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "⚠️  .env dosyası .env.example'dan oluşturuldu."
  echo "⚠️  Lütfen 'nano .env' ile TOKEN / CLIENT_ID / OWNER_ID bilgilerinizi girin."
fi

echo ""
echo "✅ Kurulum tamamlandı!"
echo "➡️  Önce .env dosyanızı doldurun: nano .env"
echo "➡️  Sonra menüyü açın: bash menu.sh"
echo ""
chmod +x menu.sh start.sh install.sh 2>/dev/null
echo "⚠️  ÖNEMLİ: Bot arka planda çalışırken Discord'da OFFLINE görünmesin diye:"
echo "   1) Play Store / F-Droid'den 'Termux:API' uygulamasını kurun (ayrı bir uygulama)."
echo "   2) Android Ayarlar > Uygulamalar > Termux > Pil > 'Kısıtlama yok / Optimize etme'"
echo "      seçeneğini işaretleyin (aksi halde Android bağlantıyı arka planda keser)."
