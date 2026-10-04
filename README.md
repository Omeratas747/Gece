# discord-bot
# Discord Güvenlik & Moderasyon Botu
HATA BULURSANIZ KODDA VEYA BİR AÇIK BİLDİRİN E POSTA = omeratas855@gmail.com

SQLite tabanlı, kredi/ödeme sistemi ile çalışan bir Discord güvenlik ve moderasyon botu.

## Özellikler

- **Ücretli `/ekle` sistemi** — kullanıcılar kredi karşılığında botu kendi sunucularına ekler, resmi Discord OAuth2 akışını kullanır
- **Otomatik yedekleme** — bota katıldığı her sunucunun rol ve kanallarını yedekler
- **`/kurtar`** — bir sunucuyu en son yedekten hiyerarşik olarak geri yükler
- **Akıllı `/karantina`** — kanalları kilitler, önceden kilitli olanların durumunu bozmadan açar
- **Anlık audit-log alarmı** — kritik işlemlerde (ban, rol/kanal silme) sunucu sahibine DM
- **Temel moderasyon** — `/ban`, `/unban`, `/mute`, `/unmute`, `/sohbet kilitle|ac`
- **Yapay zeka sohbet** — OpenRouter, Gemini, OpenAI veya Claude ile; bot etiketlenince ya da adı mesajda geçince devreye girer, kanal başına son 50 mesajlık bağlam tutar
- **İzinsiz ekleme koruması** — bot, ödeme akışı dışında bir sunucuya eklenirse (bot kapalıyken eklenmiş olsa bile sonradan fark edip) otomatik ayrılır

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını doldurun
npm start
```

Node.js 18 veya üzeri gerekir. `better-sqlite3` native bir modül olduğu için bazı ortamlarda (örn. 32-bit ARM) derleme araçları (`python3`, `make`, `g++`/`clang`) gerekebilir.

### Termux'ta çalıştırma

`install.sh`, `menu.sh` ve `start.sh` dosyaları Termux'a özeldir ve isteğe bağlıdır:

```bash
bash install.sh   # paketleri kurar
bash menu.sh      # başlat/durdur/log/ayar menüsü
```

## Ortam değişkenleri

`.env.example` dosyasına bakın. Zorunlu olanlar: `TOKEN`, `CLIENT_ID`, `OWNER_ID`. Yapay zeka sohbeti isteğe bağlıdır; `AI_PROVIDER` ile hangi sağlayıcının kullanılacağı seçilir, ilgili sağlayıcının API anahtarı girilmelidir.

## Lisans

Bu projenin lisans koşulları için [LICENSE](./LICENSE) dosyasına bakın.
