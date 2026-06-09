# Email Telegram AI Forwarder Node.js + MySQL

Aplikasi lokal Node.js yang menggabungkan:

- chatbot Telegram pencatat pemasukan/pengeluaran dari `mhdalfarisy/chatbot-catat-duitku`
- scanner email Gmail/Outlook via IMAP
- filter email penting dengan rules atau OpenAI
- penyimpanan semua data ke MySQL
- pengiriman email penting ke Telegram Bot khusus email
- bot Telegram terpisah untuk Catat Duitku

Flow asli chatbot keuangan disimpan di `Flow Chatbot Telegram + Claude.png`.

## Versi Node.js yang disarankan

Gunakan Node.js 24 LTS.

Alasannya: Node 24 adalah lini LTS yang stabil dan masa support-nya panjang. Node 26 sudah ada, tetapi masih Current, jadi kurang ideal untuk aplikasi yang ingin stabil.

Download: https://nodejs.org/

## Setup MySQL

Jalankan SQL ini di MySQL:

```sql
SOURCE schema.sql;
```

Atau buka isi `schema.sql`, lalu jalankan di MySQL Workbench / phpMyAdmin.

## Struktur Source Code

```text
src/server.js - entrypoint, start HTTP server dan polling bot
src/config.js - baca .env dan konfigurasi
src/db.js - koneksi MySQL dan schema table
src/telegram.js - helper Telegram API dan polling
src/finance.js - logic Bot Catat Duitku
src/emailForwarder.js - logic email scanner/forwarder
src/httpServer.js - dashboard web dan API lokal
```

## Install dependency

```powershell
cd outputs\email-telegram-ai-forwarder-node
npm install
```

## Konfigurasi

Copy `.env.example` menjadi `.env`, lalu isi:

```text
MYSQL_USER=root
MYSQL_PASSWORD=password_mysql_anda
MYSQL_DATABASE=email_forwarder

EMAIL_PROVIDER=gmail
EMAIL_FORWARDER_ENABLED=false
IMAP_HOST=imap.gmail.com
EMAIL_ADDRESS=email@gmail.com
EMAIL_PASSWORD=app_password_gmail

EMAIL_TELEGRAM_BOT_TOKEN=token_bot_email_forwarder
EMAIL_TELEGRAM_CHAT_ID=chat_id_tujuan_notifikasi_email
EMAIL_TELEGRAM_ALLOWED_CHAT_IDS=chat_id_yang_boleh_kontrol_bot_email

FINANCE_TELEGRAM_BOT_TOKEN=token_bot_catat_duitku
FINANCE_ADMIN_CHAT_IDS=chat_id_admin_yang_boleh_approve_user
```

Untuk Outlook:

```text
EMAIL_PROVIDER=outlook
IMAP_HOST=outlook.office365.com
```

Saat ingin fokus test Bot Catat Duitku saja, biarkan:

```text
EMAIL_FORWARDER_ENABLED=false
```

Jika nanti email forwarder sudah siap dites, ubah menjadi:

```text
EMAIL_FORWARDER_ENABLED=true
```

## Jalankan

```powershell
npm start
```

Buka:

```text
http://127.0.0.1:8765
```

Kedua bot Telegram langsung aktif dengan long polling saat server berjalan.

## Bot Catat Duitku

User baru yang chat bot akan diminta registrasi:

```text
nama lengkap
email
nomor HP
```

Setelah itu admin menerima notifikasi dan bisa approve/reject:

```text
/approve TELEGRAM_USER_ID
/reject TELEGRAM_USER_ID
```

User yang belum di-approve belum bisa mencatat transaksi atau melihat laporan.

```text
/start atau /help - panduan
/laporan - laporan pemasukan dan pengeluaran bulan ini
/laporan_sheet - generate/update laporan di Google Sheets satu halaman
/rekap - rekap bulan ini
/rekap minggu - rekap minggu ini
/rekap hari ini - rekap hari ini
/rekap 2026-06 - rekap bulan tertentu
/rekap 2026-06-08 - rekap tanggal tertentu
/rekap kategori makanan - rekap kategori tertentu
/ringkas - saran hemat dari OpenAI
/bantuan - tips keuangan
/sync_token - buat token untuk sync mobile app
```

Format transaksi:

```text
makanan 50000 makan siang
transport 25000 ojek
gaji 5000000 gaji bulanan
pemasukan 250000 freelance
saya beli nanas kupas 15ribu
beli kopi 15k
bayar listrik 150000
```

Untuk nota/struk Alfamart atau Indomaret, atau bukti transfer myBCA/BRI Mobile, kirim foto langsung ke Bot Catat Duitku. Bot akan:

1. Mengambil foto dari Telegram.
2. Membaca gambar dengan OpenAI vision OCR.
3. Mendeteksi tipe dokumen: belanja, transfer masuk, atau transfer keluar.
4. Menyimpan total ke `finance_entries` sebagai pemasukan atau pengeluaran.
5. Menyimpan detail gambar ke `finance_receipts`.
6. Menyimpan item belanja ke `finance_receipt_items` jika ada.

Model OCR default:

```text
RECEIPT_OCR_MODEL=gpt-4.1-mini
```

Untuk bukti transfer masuk, OCR memakai nama user dari data registrasi di `finance_users.full_name`. Jika nama user muncul di bagian `Tujuan` atau `Penerima`, gambar akan dicatat sebagai `Transfer Masuk`. Jika nama user muncul di `Sumber Dana` atau `Pengirim`, akan dicatat sebagai `Transfer Keluar`.

## Struktur Database Finance

Data finance disimpan dengan struktur yang siap dipakai mobile app:

```text
finance_users - identitas user Telegram dan internal user id
finance_accounts - dompet/rekening user
finance_categories - kategori pemasukan/pengeluaran
finance_entries - transaksi pemasukan/pengeluaran
finance_sync_tokens - token sync mobile yang disimpan sebagai hash
```

Untuk aplikasi mobile, jangan jadikan `telegram_user_id` sebagai satu-satunya credential. Rekomendasi:

1. User kirim `/sync_token` ke bot Finance.
2. Bot membuat token sekali pakai/bermasa berlaku dan menyimpan hash-nya di `finance_sync_tokens`.
3. Mobile app mengirim token itu ke backend.
4. Backend validasi hash token, lalu tahu internal `finance_users.id`.
5. Setelah itu mobile sync data berdasarkan internal `user_id`, bukan berdasarkan nama atau chat id.

Dengan cara ini, Telegram tetap jadi sumber onboarding, tapi mobile app punya mekanisme auth yang lebih aman dan bisa dicabut.

## Laporan Google Sheets

Laporan Google Sheets dibuat dalam **1 tab saja** bernama `Laporan Keuangan`. Aplikasi akan menghapus tab lain di spreadsheet target, lalu mengisi:

- KPI pemasukan, pengeluaran, saldo, rasio tabungan
- rekap bulanan 12 bulan
- kategori bulan ini
- detail transaksi terbaru

Setup yang disarankan:

1. Buat project di Google Cloud.
2. Enable Google Sheets API.
3. Buat Service Account dan download JSON key.
4. Buat Google Sheet kosong.
5. Share Google Sheet itu ke email service account, biasanya formatnya `...@...iam.gserviceaccount.com`.
6. Isi `.env`:

```text
GOOGLE_SHEETS_ENABLED=true
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\path\service-account.json
GOOGLE_SHEET_ID=id_atau_url_google_sheet
GOOGLE_SHEET_NAME=Laporan Keuangan
```

Generate laporan dari bot:

```text
/laporan_sheet
```

## Bot Email Forwarder

```text
/start atau /help - panduan
/email_scan atau /scan - scan email dan kirim email penting
/email_preview atau /preview - scan email tanpa kirim
/email_status atau /status - status scan email terakhir
```

Notifikasi email penting otomatis dikirim memakai `EMAIL_TELEGRAM_BOT_TOKEN` ke `EMAIL_TELEGRAM_CHAT_ID`.

## Mode AI

Default-nya aplikasi pakai rules lokal dari `IMPORTANT_KEYWORDS` dan `IMPORTANT_SENDERS`.

Untuk pakai OpenAI:

```text
USE_OPENAI=true
OPENAI_API_KEY=isi_api_key_anda
OPENAI_MODEL=gpt-4.1-mini
```

Jika OpenAI gagal, aplikasi otomatis fallback ke rules lokal.

## OpenAI untuk chatbot keuangan

Finance bot memakai `OPENAI_API_KEY` yang sama. Supaya irit, gunakan model kecil:

```text
OPENAI_API_KEY=isi_api_key_openai
FINANCE_OPENAI_MODEL=gpt-4.1-nano
```

## Catatan Gmail dan Outlook

Gmail biasanya perlu App Password, bukan password utama akun.

Outlook/Microsoft 365 kadang menolak login IMAP password biasa jika tenant wajib OAuth. Untuk kebutuhan produksi, flow OAuth Microsoft Graph lebih aman, tapi IMAP lebih cepat untuk versi awal ini.
