import calendar
import csv
import hmac
import io
import math
import re
import secrets
import threading
from datetime import date, datetime, time, timedelta, timezone
from functools import wraps
from urllib.parse import parse_qsl, urlencode
from flask import Flask, Response, abort, render_template, request, redirect, url_for, session, flash

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

app = Flask(__name__)
app.secret_key = "ganti-dengan-secret-key-kamu"

# ---------- ZONA WAKTU ----------
# Asia/Jakarta = UTC+7 dan tidak memakai DST. Jika data zona waktu IANA tidak
# tersedia (misalnya Windows tanpa paket tzdata), pakai offset tetap +07:00
# supaya tidak perlu library tambahan.
try:
    TZ_JAKARTA = ZoneInfo("Asia/Jakarta")
except Exception:
    TZ_JAKARTA = timezone(timedelta(hours=7), "WIB")

NAMA_HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]
NAMA_BULAN = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
]


def sekarang():
    """Waktu saat ini di Asia/Jakarta."""
    return datetime.now(TZ_JAKARTA)


def format_tanggal_id(d):
    """Contoh: 'Senin, 19 Oktober 2026' (tidak bergantung pada locale OS)."""
    return f"{NAMA_HARI[d.weekday()]}, {d.day} {NAMA_BULAN[d.month - 1]} {d.year}"


# ---------- DATA DUMMY (ganti dengan database nanti) ----------
USERS = {"admin": "admin123"}

KARYAWAN = [
    {"id": "EMP001", "nama": "Andi Pratama", "jabatan": "Software Engineer", "email": "andi@company.com", "hp": "0812-3456-7890", "status": "Aktif"},
    {"id": "EMP002", "nama": "Sari Dewi", "jabatan": "HR Manager", "email": "sari@company.com", "hp": "0812-3456-7891", "status": "Aktif"},
    {"id": "EMP003", "nama": "Budi Santoso", "jabatan": "Marketing Staff", "email": "budi@company.com", "hp": "0812-3456-7892", "status": "Nonaktif"},
    {"id": "EMP004", "nama": "Dewi Puspa", "jabatan": "Finance Analyst", "email": "dewi@company.com", "hp": "0812-3456-7893", "status": "Aktif"},
    {"id": "EMP005", "nama": "Rudi Hartono", "jabatan": "IT Support", "email": "rudi@company.com", "hp": "0812-3456-7894", "status": "Aktif"},
]


def _waktu(hari_lalu, jam, menit):
    """Bantu bikin datetime dummy relatif terhadap hari ini (WIB)."""
    d = sekarang().date() - timedelta(days=hari_lalu)
    return datetime(d.year, d.month, d.day, jam, menit, tzinfo=TZ_JAKARTA)


# Format catatan absensi (BARU, menggantikan format lama yang hanya berisi
# nama + jam sebagai teks). Tiap catatan memuat:
#   id_karyawan -> merujuk KARYAWAN[i]["id"]
#   waktu       -> datetime lengkap (tanggal + jam), bukan string "08:01"
#   jenis       -> "Check In" / "Check Out"
#   status      -> "Tepat Waktu" / "Terlambat"
# Karyawan yang tidak absen TIDAK punya catatan (tidak ada baris "Tidak Hadir"
# palsu dengan waktu "-").
LOG_ABSENSI = [
    {"id_karyawan": "EMP001", "waktu": _waktu(0, 8, 1),   "jenis": "Check In",  "status": "Tepat Waktu"},
    {"id_karyawan": "EMP002", "waktu": _waktu(0, 8, 15),  "jenis": "Check In",  "status": "Terlambat"},
    {"id_karyawan": "EMP003", "waktu": _waktu(0, 17, 2),  "jenis": "Check Out", "status": "Tepat Waktu"},
    # contoh data hari sebelumnya (tidak boleh ikut statistik hari ini)
    {"id_karyawan": "EMP005", "waktu": _waktu(1, 8, 5),   "jenis": "Check In",  "status": "Tepat Waktu"},
    {"id_karyawan": "EMP001", "waktu": _waktu(1, 8, 0),   "jenis": "Check In",  "status": "Tepat Waktu"},
]

# Belum ada sumber data pemberitahuan di proyek. Kosongkan dulu; isi dengan
# string/dict dari sumber nyata (mis. tabel pengajuan) saat fiturnya ada.
PEMBERITAHUAN = []

# Pengajuan Izin & Cuti (list Python di memori, sama seperti KARYAWAN dan
# LOG_ABSENSI: hilang saat server di-restart). Struktur tiap pengajuan ada di
# bagian "PENGAJUAN IZIN & CUTI" di bawah. Sengaja kosong: tidak ada data dummy.
PENGAJUAN = []

JUMLAH_LOG_DASHBOARD = 5

# ---------- KONFIGURASI JADWAL ABSENSI ----------
# Satu-satunya tempat yang perlu diubah untuk mengganti jam kerja. Validasi
# backend DAN kartu "Informasi Jadwal" di halaman Absensi membaca nilai ini.
JAM_MULAI_DATANG = time(7, 0)         # absen datang dianggap mulai pukul ini
JAM_BATAS_TEPAT_WAKTU = time(7, 30)   # sampai 07:30:00 (inklusif) = Tepat Waktu
JAM_MULAI_PULANG = time(16, 0)        # absen pulang baru dibuka pukul ini
# Hari kerja (Senin=0 ... Minggu=6). Dipakai Riwayat Absensi: karyawan aktif tanpa
# absen datang baru dianggap "Tidak Hadir" pada hari kerja, bukan akhir pekan.
HARI_KERJA = (0, 1, 2, 3, 4)


# ---------- LOGIKA STATISTIK ----------
def _aktif(k):
    """Karyawan yang wajib hadir: berstatus 'Aktif' dan belum dihapus.
    Status 'Nonaktif' dan 'Cuti' tidak ikut dihitung (tidak dianggap tidak hadir)."""
    return k.get("status") == "Aktif" and not k.get("dihapus")


def _persen(bagian, dasar):
    """Persentase bulat (half-up). Aman untuk dasar 0."""
    if not dasar:
        return 0
    return int(bagian * 100 / dasar + 0.5)


def hitung_statistik(karyawan, log_absensi, hari_ini, pengajuan=None):
    """Hitung statistik dashboard dari data aktual.

    - total        : seluruh data karyawan (termasuk nonaktif/cuti, tidak termasuk yang dihapus)
    - hadir        : karyawan AKTIF unik yang punya catatan absensi hari ini
    - terlambat    : karyawan AKTIF unik dengan Check In berstatus 'Terlambat' hari ini
    - tidak_hadir  : karyawan aktif - hadir - yang punya Izin/Cuti DISETUJUI hari ini (>= 0)
    - izin_cuti    : karyawan aktif yang belum absen tetapi punya pengajuan Disetujui hari ini
                     (pengajuan Menunggu/Ditolak tidak berpengaruh)
    - persen_*     : dihitung dari jumlah karyawan aktif
    Catatan yang id_karyawan-nya tidak ada di data karyawan diabaikan.
    """
    aktif_ids = {k["id"] for k in karyawan if _aktif(k)}

    hadir_ids, terlambat_ids = set(), set()
    for rec in log_absensi:
        waktu = rec.get("waktu")
        if not isinstance(waktu, datetime):
            continue
        if waktu.astimezone(TZ_JAKARTA).date() != hari_ini:
            continue
        if rec.get("jenis") not in ("Check In", "Check Out"):
            continue
        kid = rec.get("id_karyawan")
        if kid not in aktif_ids:
            continue
        hadir_ids.add(kid)
        if rec.get("jenis") == "Check In" and rec.get("status") == "Terlambat":
            terlambat_ids.add(kid)

    total_aktif = len(aktif_ids)
    hadir = len(hadir_ids)
    terlambat = len(terlambat_ids)
    izin_cuti = len({
        kid for kid in aktif_ids - hadir_ids
        if pengajuan_disetujui(kid, hari_ini, pengajuan) is not None
    })
    tidak_hadir = total_aktif - hadir - izin_cuti

    return {
        "total": sum(1 for k in karyawan if not k.get("dihapus")),
        "aktif": total_aktif,
        "hadir": hadir,
        "terlambat": terlambat,
        "izin_cuti": izin_cuti,
        "tidak_hadir": tidak_hadir,
        "persen_hadir": _persen(hadir, total_aktif),
        "persen_terlambat": _persen(terlambat, total_aktif),
        "persen_tidak_hadir": _persen(tidak_hadir, total_aktif),
    }


def log_terbaru(karyawan, log_absensi, batas=JUMLAH_LOG_DASHBOARD):
    """Catatan absensi terbaru (semua tanggal), terurut waktu menurun, dengan nama dari data karyawan."""
    nama_by_id = {k["id"]: k["nama"] for k in karyawan}
    valid = [
        r for r in log_absensi
        if isinstance(r.get("waktu"), datetime) and r.get("id_karyawan") in nama_by_id
    ]
    valid.sort(key=lambda r: r["waktu"], reverse=True)
    hasil = []
    for r in valid[:batas]:
        w = r["waktu"].astimezone(TZ_JAKARTA)
        hasil.append({
            "nama": nama_by_id[r["id_karyawan"]],
            "waktu": w.strftime("%H:%M"),
            "tanggal": w.date(),
            "jenis": r["jenis"],
            "status": r["status"],
        })
    return hasil


# ---------- AUTH ----------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


@app.route("/", methods=["GET", "POST"])
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        if USERS.get(username) == password:
            session["user"] = username
            return redirect(url_for("dashboard"))
        flash("Username atau password salah", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------- HALAMAN ----------
@app.route("/dashboard")
@login_required
def dashboard():
    hari_ini = sekarang().date()
    stats = hitung_statistik(KARYAWAN, LOG_ABSENSI, hari_ini)
    logs = log_terbaru(KARYAWAN, LOG_ABSENSI)
    return render_template(
        "dashboard.html",
        stats=stats,
        logs=logs,
        tanggal_hari_ini=format_tanggal_id(hari_ini),
        hari_ini=hari_ini,
        pemberitahuan=PEMBERITAHUAN,
        active="dashboard",
    )


# ---------- DATA KARYAWAN (CRUD) ----------
# Penyimpanan masih list Python di memori (KARYAWAN): data hilang jika server
# di-restart. Penghapusan memakai SOFT DELETE (flag "dihapus": True) supaya
# riwayat absensi (LOG_ABSENSI merujuk id_karyawan) tidak yatim/rusak dan ID
# tidak pernah dipakai ulang.
STATUS_KARYAWAN = ("Aktif", "Nonaktif", "Cuti")
PER_PAGE = 10
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HP_RE = re.compile(r"^(?:\+62|62|0)(8\d{8,11})$")  # nomor seluler Indonesia
_kunci_data = threading.Lock()


@app.context_processor
def inject_csrf():
    def csrf_token():
        if "csrf" not in session:
            session["csrf"] = secrets.token_urlsafe(32)
        return session["csrf"]
    return {"csrf_token": csrf_token}


def _csrf_ok():
    token = session.get("csrf", "")
    kirim = request.form.get("csrf_token", "")
    return bool(token) and hmac.compare_digest(token, kirim)


def karyawan_terlihat():
    return [k for k in KARYAWAN if not k.get("dihapus")]


def cari_karyawan(kid):
    for k in KARYAWAN:
        if k["id"] == kid and not k.get("dihapus"):
            return k
    return None


def buat_id_baru():
    """EMP001, EMP002, ... berdasarkan angka terbesar (termasuk yang sudah dihapus)."""
    angka = [int(m.group(1)) for k in KARYAWAN if (m := re.fullmatch(r"EMP(\d+)", k["id"]))]
    return f"EMP{(max(angka) if angka else 0) + 1:03d}"


def normalisasi_hp(mentah):
    """081234567890 / +6281234567890 / 0812-3456-7890 -> '0812-3456-7890'. None jika tidak valid."""
    bersih = re.sub(r"[\s\-().]", "", mentah)
    m = HP_RE.match(bersih)
    if not m:
        return None
    nasional = "0" + m.group(1)
    return f"{nasional[:4]}-{nasional[4:8]}-{nasional[8:]}"


def validasi_karyawan(form, id_sendiri=None, dengan_status=False):
    """Validasi input tambah/edit di backend. Return (nilai, errors)."""
    nilai = {
        "nama": " ".join(form.get("nama", "").split()),
        "email": form.get("email", "").strip(),
        "hp": form.get("hp", "").strip(),
        "jabatan": " ".join(form.get("jabatan", "").split()),
    }
    if dengan_status:
        nilai["status"] = form.get("status", "").strip()
    errors = {}

    if not nilai["nama"]:
        errors["nama"] = "Nama lengkap wajib diisi."
    elif len(nilai["nama"]) < 2 or len(nilai["nama"]) > 100:
        errors["nama"] = "Nama harus 2–100 karakter."

    if not nilai["email"]:
        errors["email"] = "Email wajib diisi."
    elif len(nilai["email"]) > 254 or not EMAIL_RE.match(nilai["email"]):
        errors["email"] = "Format email tidak valid."
    else:
        email = nilai["email"].lower()
        dipakai = any(
            k["email"].lower() == email and k["id"] != id_sendiri
            for k in karyawan_terlihat()
        )
        if dipakai:
            errors["email"] = "Email sudah digunakan karyawan lain."
        else:
            nilai["email"] = email

    if not nilai["hp"]:
        errors["hp"] = "Nomor HP wajib diisi."
    else:
        hp = normalisasi_hp(nilai["hp"])
        if hp is None:
            errors["hp"] = "Nomor HP tidak valid. Contoh: 081234567890 atau +6281234567890."
        else:
            nilai["hp"] = hp

    if not nilai["jabatan"]:
        errors["jabatan"] = "Jabatan wajib diisi."
    elif len(nilai["jabatan"]) < 2 or len(nilai["jabatan"]) > 100:
        errors["jabatan"] = "Jabatan harus 2–100 karakter."

    if dengan_status and nilai["status"] not in STATUS_KARYAWAN:
        errors["status"] = "Status harus Aktif, Nonaktif, atau Cuti."

    return nilai, errors


def daftar_halaman(page, jumlah, lebar=1):
    """Daftar nomor halaman untuk pagination; None = elipsis."""
    if jumlah <= 7:
        return list(range(1, jumlah + 1))
    tampil = {1, jumlah} | set(range(page - lebar, page + lebar + 1))
    hasil, prev = [], 0
    for n in sorted(x for x in tampil if 1 <= x <= jumlah):
        if n - prev > 1:
            hasil.append(None)
        hasil.append(n)
        prev = n
    return hasil


def _cocok(k, kw):
    kw_angka = re.sub(r"\D", "", kw)
    for f in ("id", "nama", "jabatan", "email", "hp"):
        if kw in str(k[f]).lower():
            return True
    return bool(kw_angka) and kw_angka in re.sub(r"\D", "", k["hp"])


def render_karyawan(q, page, modal=None, status_code=200):
    q = (q or "").strip()
    semua = karyawan_terlihat()
    hasil = [k for k in semua if _cocok(k, q.lower())] if q else semua
    total = len(hasil)
    jumlah_hal = max(1, math.ceil(total / PER_PAGE))
    page = min(max(page or 1, 1), jumlah_hal)  # halaman valid terdekat
    mulai = (page - 1) * PER_PAGE
    data = hasil[mulai:mulai + PER_PAGE]
    html = render_template(
        "karyawan.html",
        data=data, q=q, page=page, jumlah_hal=jumlah_hal,
        halaman=daftar_halaman(page, jumlah_hal),
        total=total, total_semua=len(semua),
        awal=mulai + 1 if data else 0, akhir=mulai + len(data),
        status_list=STATUS_KARYAWAN, modal=modal, active="karyawan",
    )
    return html, status_code


def _kembali(q, page):
    return redirect(url_for("karyawan", q=q or None, page=page if page and page > 1 else None))


def _konteks_form():
    return request.form.get("q", "").strip(), request.form.get("page", 1, type=int)


@app.route("/karyawan")
@login_required
def karyawan():
    return render_karyawan(request.args.get("q", ""), request.args.get("page", 1, type=int))


@app.route("/karyawan/tambah", methods=["POST"])
@login_required
def karyawan_tambah():
    q, page = _konteks_form()
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali(q, page)
    with _kunci_data:
        nilai, errors = validasi_karyawan(request.form)
        if errors:
            return render_karyawan(q, page, {"mode": "tambah", "nilai": nilai, "errors": errors}, 400)
        baru = {"id": buat_id_baru(), **nilai, "status": "Aktif"}
        KARYAWAN.append(baru)
    flash(f"Karyawan {baru['nama']} ({baru['id']}) berhasil ditambahkan.", "success")
    halaman_akhir = max(1, math.ceil(len(karyawan_terlihat()) / PER_PAGE))
    return _kembali("", halaman_akhir)  # tampilkan baris baru (ada di halaman terakhir)


@app.route("/karyawan/<kid>/edit", methods=["POST"])
@login_required
def karyawan_edit(kid):
    q, page = _konteks_form()
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali(q, page)
    with _kunci_data:
        k = cari_karyawan(kid)
        if k is None:
            flash("Karyawan tidak ditemukan.", "error")
            return _kembali(q, page)
        nilai, errors = validasi_karyawan(request.form, id_sendiri=kid, dengan_status=True)
        if errors:
            return render_karyawan(q, page, {"mode": "edit", "id": kid, "nilai": nilai, "errors": errors}, 400)
        k.update(nilai)  # hanya nama/email/hp/jabatan/status; ID dan riwayat absensi tidak disentuh
    flash(f"Data {k['nama']} ({k['id']}) berhasil diperbarui.", "success")
    return _kembali(q, page)


@app.route("/karyawan/<kid>/hapus", methods=["POST"])
@login_required
def karyawan_hapus(kid):
    q, page = _konteks_form()
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali(q, page)
    with _kunci_data:
        k = cari_karyawan(kid)
        if k is None:
            flash("Karyawan tidak ditemukan atau sudah dihapus.", "error")
            return _kembali(q, page)
        k["dihapus"] = True  # soft delete: LOG_ABSENSI tetap utuh
    flash(f"Karyawan {k['nama']} ({k['id']}) berhasil dihapus.", "success")
    return _kembali(q, page)  # render_karyawan mengoreksi halaman jika sudah melewati halaman terakhir


# ---------- ABSENSI HARIAN ----------
# Memakai sumber data yang sama dengan Dashboard (LOG_ABSENSI): satu catatan per
# kejadian ("Check In" / "Check Out"). Penyimpanan masih list Python di memori,
# jadi catatan hilang saat server di-restart (sama seperti data karyawan).
# Waktu SELALU diambil dari backend (sekarang()), tidak pernah dari browser.


def fmt_jam(t):
    """time/datetime -> '07.30' (format jam Indonesia untuk tampilan jadwal)."""
    return f"{t.hour:02d}.{t.minute:02d}"


def _catatan_hari(kid, jenis, tanggal):
    """Catatan absensi karyawan `kid` berjenis `jenis` pada `tanggal` (WIB), atau None."""
    for rec in LOG_ABSENSI:
        w = rec.get("waktu")
        if (rec.get("id_karyawan") == kid and rec.get("jenis") == jenis
                and isinstance(w, datetime) and w.astimezone(TZ_JAKARTA).date() == tanggal):
            return rec
    return None


def _jam(rec):
    return rec["waktu"].astimezone(TZ_JAKARTA).strftime("%H:%M:%S")


def status_datang(waktu):
    """'Tepat Waktu' jika <= batas (07:30:00 inklusif), selain itu 'Terlambat'.
    Pembanding dipotong ke detik: 07:30:00.9 masih 07:30:00 (tepat waktu),
    07:30:01 sudah terlambat. Sebelum jam mulai tetap 'Tepat Waktu'."""
    return "Tepat Waktu" if waktu.replace(microsecond=0).time() <= JAM_BATAS_TEPAT_WAKTU else "Terlambat"


def _periksa_karyawan(kid):
    """Return (karyawan, None) jika boleh absen, atau (None, pesan_error)."""
    if not kid:
        return None, "Silakan pilih nama karyawan terlebih dahulu."
    k = cari_karyawan(kid)
    if k is None:
        return None, "Karyawan tidak terdaftar. Pilih nama dari daftar yang tersedia."
    if k.get("status") != "Aktif":
        return None, f"{k['nama']} berstatus {k['status']} dan tidak dapat melakukan absensi."
    return k, None


def catat_absen_datang(kid, waktu):
    """Validasi + simpan absen datang. Return (kategori_flash, pesan)."""
    waktu = waktu.astimezone(TZ_JAKARTA).replace(microsecond=0)
    with _kunci_data:  # cek-lalu-simpan atomik: cegah catatan ganda
        k, err = _periksa_karyawan(kid)
        if err:
            return "error", err
        sudah = _catatan_hari(k["id"], "Check In", waktu.date())
        if sudah:
            return "error", f"{k['nama']} sudah melakukan absen datang hari ini pukul {_jam(sudah)} WIB."
        status = status_datang(waktu)
        rec = {"id_karyawan": k["id"], "waktu": waktu, "jenis": "Check In", "status": status}
        LOG_ABSENSI.append(rec)
    pesan = f"Absen datang berhasil: {k['nama']} ({k['id']}) tercatat pukul {_jam(rec)} WIB"
    if status == "Terlambat":
        return "warning", pesan + " dengan status Terlambat."
    if waktu.time() < JAM_MULAI_DATANG:
        pesan += f" (lebih awal dari jadwal mulai {fmt_jam(JAM_MULAI_DATANG)} WIB)"
    return "success", pesan + ", status Tepat Waktu."


def catat_absen_pulang(kid, waktu):
    """Validasi + simpan absen pulang. Return (kategori_flash, pesan)."""
    waktu = waktu.astimezone(TZ_JAKARTA).replace(microsecond=0)
    with _kunci_data:
        k, err = _periksa_karyawan(kid)
        if err:
            return "error", err
        if _catatan_hari(k["id"], "Check In", waktu.date()) is None:
            return "error", "Silakan lakukan absen datang terlebih dahulu."
        sudah = _catatan_hari(k["id"], "Check Out", waktu.date())
        if sudah:
            return "error", f"{k['nama']} sudah melakukan absen pulang hari ini pukul {_jam(sudah)} WIB."
        if waktu.time() < JAM_MULAI_PULANG:
            return "error", f"Jadwal absen pulang belum dimulai. Absen pulang dibuka mulai pukul {fmt_jam(JAM_MULAI_PULANG)} WIB."
        # Status pulang tidak pernah 'Terlambat'; 'Tepat Waktu' = nilai netral
        # agar badge di Dashboard konsisten dengan data yang sudah ada.
        rec = {"id_karyawan": k["id"], "waktu": waktu, "jenis": "Check Out", "status": "Tepat Waktu"}
        LOG_ABSENSI.append(rec)
    return "success", f"Absen pulang berhasil: {k['nama']} ({k['id']}) tercatat pukul {_jam(rec)} WIB."


@app.route("/absensi")
@login_required
def absensi():
    pilihan = sorted(
        (k for k in karyawan_terlihat() if k.get("status") == "Aktif"),
        key=lambda k: k["nama"].lower(),
    )
    jadwal = {
        "mulai_datang": fmt_jam(JAM_MULAI_DATANG),
        "batas_tepat": fmt_jam(JAM_BATAS_TEPAT_WAKTU),
        "mulai_pulang": fmt_jam(JAM_MULAI_PULANG),
    }
    return render_template("absensi.html", karyawan_aktif=pilihan, jadwal=jadwal, active="absensi")


def _proses_absen(fungsi):
    """Pola POST-Redirect-GET: validasi CSRF, catat, flash hasil, kembali ke /absensi.
    Redirect mencegah refresh halaman mengirim ulang formulir."""
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
    else:
        kategori, pesan = fungsi(request.form.get("id_karyawan", "").strip(), sekarang())
        flash(pesan, kategori)
    return redirect(url_for("absensi"))


@app.route("/absensi/datang", methods=["POST"])
@login_required
def absensi_datang():
    return _proses_absen(catat_absen_datang)


@app.route("/absensi/pulang", methods=["POST"])
@login_required
def absensi_pulang():
    return _proses_absen(catat_absen_pulang)


# ---------- RIWAYAT ABSENSI ----------
# Membaca KARYAWAN + LOG_ABSENSI yang sama dengan Dashboard dan Absensi Harian
# (tidak ada data terpisah). Satu baris riwayat = satu karyawan pada satu hari:
# Check In dan Check Out digabung. Baris "Tidak Hadir"/"Cuti" dihitung saat
# ditampilkan, tidak disimpan.
STATUS_RIWAYAT = ("Tepat Waktu", "Terlambat", "Tidak Hadir", "Cuti", "Izin")
PER_PAGE_RIWAYAT = 20
RENTANG_DEFAULT_HARI = 30   # tanpa filter tanggal: 30 hari terakhir sampai hari ini
RENTANG_MAKS_HARI = 366


def format_tanggal_pendek(d):
    """'Sen, 19 Okt 2026' (tidak bergantung pada locale OS)."""
    return f"{NAMA_HARI[d.weekday()][:3]}, {d.day} {NAMA_BULAN[d.month - 1][:3]} {d.year}"


def _parse_tanggal(teks):
    try:
        return date.fromisoformat(teks)
    except ValueError:
        return None


def parse_filter_riwayat(args, hari_ini):
    """Baca filter dari query string. Return (filter, daftar_error)."""
    errors = []
    q = " ".join(args.get("q", "").split())[:100]
    status = args.get("status", "").strip()
    if status not in STATUS_RIWAYAT:
        status = ""
    mentah_dari, mentah_sampai = args.get("dari", "").strip(), args.get("sampai", "").strip()
    sampai = _parse_tanggal(mentah_sampai) if mentah_sampai else hari_ini
    if sampai is None:
        errors.append("Format tanggal akhir tidak valid.")
        sampai = hari_ini
    dari = _parse_tanggal(mentah_dari) if mentah_dari else sampai - timedelta(days=RENTANG_DEFAULT_HARI - 1)
    if dari is None:
        errors.append("Format tanggal awal tidak valid.")
        dari = sampai - timedelta(days=RENTANG_DEFAULT_HARI - 1)
    if not errors:
        if dari > sampai:
            errors.append("Tanggal awal tidak boleh melebihi tanggal akhir.")
        elif (sampai - dari).days + 1 > RENTANG_MAKS_HARI:
            errors.append(f"Rentang tanggal maksimal {RENTANG_MAKS_HARI} hari.")
    return {"q": q, "dari": dari, "sampai": sampai, "status": status}, errors


def _keterangan(status, datang, ada_pulang, tanggal, hari_ini):
    cat = []
    if status == "Tidak Hadir":
        return "Tidak ada absen datang"
    if status == "Cuti":
        return "Sedang cuti"
    if status == "Terlambat":
        selisih = (datang.replace(microsecond=0) - datetime.combine(tanggal, JAM_BATAS_TEPAT_WAKTU, TZ_JAKARTA)).total_seconds()
        menit = math.ceil(selisih / 60)
        cat.append(f"Terlambat {menit} menit" if menit > 0 else "Terlambat")
    elif datang.time() < JAM_MULAI_DATANG:
        cat.append("Datang lebih awal")
    if not ada_pulang:
        cat.append("Belum absen pulang" if tanggal >= hari_ini else "Tidak absen pulang")
    return "; ".join(cat)


def bangun_riwayat(karyawan, log_absensi, dari, sampai, hari_ini, q="", status="", pengajuan=None):
    """Baris riwayat (terbaru dulu) untuk periode [dari, sampai] setelah filter.

    - Baris absen: karyawan yang punya Check In pada hari itu; Check Out digabung
      ke baris yang sama (tidak menggandakan). Check Out tanpa Check In diabaikan.
    - Tidak Hadir: karyawan Aktif tanpa Check In pada HARI KERJA <= hari ini.
      Nonaktif tidak pernah dianggap bolos (aplikasi belum menyimpan tanggal
      nonaktif), dan data cuti per tanggal belum ada sehingga status Cuti
      karyawan hanya berlaku untuk HARI INI.
    - Izin/Cuti: karyawan Aktif/Cuti tanpa Check In pada hari kerja yang tercakup
      pengajuan DISETUJUI tampil sebagai 'Izin'/'Cuti' (bukan Tidak Hadir).
      Pengajuan Menunggu/Ditolak diabaikan. Catatan Check In/Check Out yang sudah
      ada tidak pernah diubah atau disembunyikan.
    - Karyawan yang sudah dihapus tetap tampil pada catatan lamanya.
    """
    disetujui = _indeks_disetujui(pengajuan)
    kw = q.lower()
    by_id = {
        k["id"]: k for k in karyawan
        if not kw or kw in k["id"].lower() or kw in k["nama"].lower()
    }

    masuk, keluar = {}, {}   # (id, tanggal) -> waktu Check In terawal / Check Out terakhir
    for rec in log_absensi:
        w, kid = rec.get("waktu"), rec.get("id_karyawan")
        if not isinstance(w, datetime) or kid not in by_id:
            continue
        w = w.astimezone(TZ_JAKARTA)
        if not dari <= w.date() <= sampai:
            continue
        kunci = (kid, w.date())
        if rec.get("jenis") == "Check In":
            if kunci not in masuk or w < masuk[kunci][0]:
                masuk[kunci] = (w, rec.get("status"))
        elif rec.get("jenis") == "Check Out":
            if kunci not in keluar or w > keluar[kunci]:
                keluar[kunci] = w

    def baris(k, tgl, datang=None, pulang=None, st=None, ket=None):
        return {
            "tanggal": tgl, "id": k["id"], "nama": k["nama"], "jabatan": k.get("jabatan", ""),
            "datang": datang, "pulang": pulang, "status": st,
            "keterangan": ket if ket is not None else _keterangan(st, datang, pulang is not None, tgl, hari_ini),
        }

    rows = []
    for (kid, tgl), (w, st) in masuk.items():
        rows.append(baris(by_id[kid], tgl, w, keluar.get((kid, tgl)), st))

    hari = dari
    while hari <= min(sampai, hari_ini):
        if hari.weekday() in HARI_KERJA:
            for k in by_id.values():
                if k.get("dihapus") or (k["id"], hari) in masuk:
                    continue
                izin = _disetujui_pada(disetujui, k["id"], hari) if k.get("status") in ("Aktif", "Cuti") else None
                if izin:
                    rows.append(baris(k, hari, st=izin["jenis"], ket=f"{izin['jenis']} disetujui ({izin['id']})"))
                elif k.get("status") == "Aktif":
                    rows.append(baris(k, hari, st="Tidak Hadir"))
                elif k.get("status") == "Cuti" and hari == hari_ini:
                    rows.append(baris(k, hari, st="Cuti"))
        hari += timedelta(days=1)

    if status:
        rows = [r for r in rows if r["status"] == status]
    rows.sort(key=lambda r: r["nama"].lower())  # urutan dasar; sort berikut stabil
    rows.sort(key=lambda r: (r["tanggal"], r["datang"] is not None, r["datang"].timestamp() if r["datang"] else 0), reverse=True)
    return rows


def statistik_riwayat(rows):
    """Hitung per karyawan-per-hari dari baris yang sama dengan tabel (semua halaman)."""
    return {
        "hadir": sum(1 for r in rows if r["datang"] is not None),
        "terlambat": sum(1 for r in rows if r["status"] == "Terlambat"),
        "tidak_hadir": sum(1 for r in rows if r["status"] == "Tidak Hadir"),
    }


def _args_filter(f):
    return {"q": f["q"] or None, "dari": f["dari"].isoformat(), "sampai": f["sampai"].isoformat(), "status": f["status"] or None}


@app.route("/riwayat")
@login_required
def riwayat():
    hari_ini = sekarang().date()
    f, errors = parse_filter_riwayat(request.args, hari_ini)
    rows = [] if errors else bangun_riwayat(KARYAWAN, LOG_ABSENSI, f["dari"], f["sampai"], hari_ini, f["q"], f["status"])
    total = len(rows)
    jumlah_hal = max(1, math.ceil(total / PER_PAGE_RIWAYAT))
    page = min(max(request.args.get("page", 1, type=int) or 1, 1), jumlah_hal)
    mulai = (page - 1) * PER_PAGE_RIWAYAT
    data = rows[mulai:mulai + PER_PAGE_RIWAYAT]
    return render_template(
        "riwayat.html",
        data=data, total=total, page=page, jumlah_hal=jumlah_hal,
        halaman=daftar_halaman(page, jumlah_hal),
        awal=mulai + 1 if data else 0, akhir=mulai + len(data), nomor_awal=mulai,
        stats=statistik_riwayat(rows), f=f, errors=errors,
        satu_hari=f["dari"] == f["sampai"], hari_ini=hari_ini,
        status_list=STATUS_RIWAYAT, args=_args_filter(f),
        format_tanggal=format_tanggal_pendek, active="riwayat",
    )


def _sel_csv(teks):
    """Cegah CSV/formula injection di Excel: awali sel berbahaya dengan apostrof."""
    teks = str(teks)
    return "'" + teks if teks[:1] in ("=", "+", "-", "@", "\t", "\r") else teks


@app.route("/riwayat/export")
@login_required
def riwayat_export():
    """Ekspor CSV seluruh hasil filter aktif (bukan hanya halaman yang terlihat)."""
    hari_ini = sekarang().date()
    f, errors = parse_filter_riwayat(request.args, hari_ini)
    if errors:
        for e in errors:
            flash(e, "error")
        return redirect(url_for("riwayat", **{k: v for k, v in request.args.items() if k != "page"}))
    rows = bangun_riwayat(KARYAWAN, LOG_ABSENSI, f["dari"], f["sampai"], hari_ini, f["q"], f["status"])
    buf = io.StringIO()
    tulis = csv.writer(buf)
    tulis.writerow(["Tanggal", "ID Karyawan", "Nama", "Jabatan", "Jam Datang", "Jam Pulang", "Status", "Keterangan"])
    for r in rows:
        tulis.writerow([
            r["tanggal"].isoformat(), _sel_csv(r["id"]), _sel_csv(r["nama"]), _sel_csv(r["jabatan"]),
            r["datang"].strftime("%H:%M") if r["datang"] else "",
            r["pulang"].strftime("%H:%M") if r["pulang"] else "",
            r["status"], r["keterangan"],
        ])
    nama_file = f"riwayat_absensi_{f['dari'].isoformat()}_{f['sampai'].isoformat()}.csv"
    return Response(
        "\ufeff" + buf.getvalue(),  # BOM agar Excel membaca UTF-8
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{nama_file}"'},
    )


# ---------- PENGAJUAN IZIN & CUTI ----------
# Sumber data: list PENGAJUAN (di memori, hilang saat server di-restart, sama
# seperti KARYAWAN/LOG_ABSENSI). Satu pengajuan:
#   id               -> "PGJ-0001" (unik, tidak pernah dipakai ulang)
#   id_karyawan      -> merujuk KARYAWAN[i]["id"]; nama/jabatan SELALU dibaca dari
#                       data karyawan (tidak disalin), jadi tetap sinkron
#   jenis            -> "Izin" / "Cuti"
#   mulai, selesai   -> date (inklusif)
#   alasan           -> teks
#   diajukan         -> datetime (WIB), diajukan_oleh -> username yang menginput
#   status           -> "Menunggu" / "Disetujui" / "Ditolak" (terpisah dari status karyawan)
#   diproses_oleh, diproses_pada, alasan_penolakan -> info keputusan admin
# Pengajuan TIDAK PERNAH diubah/dihapus saat data karyawan berubah (Nonaktif/dihapus).
JENIS_PENGAJUAN = ("Izin", "Cuti")
STATUS_PENGAJUAN = ("Menunggu", "Disetujui", "Ditolak")
ADMIN_USERS = {"admin"}          # hanya akun ini yang boleh membuat/menyetujui/menolak
IZIN_MUNDUR_MAKS_HARI = 7        # Izin (mis. sakit) boleh diajukan mundur sampai 7 hari; Cuti tidak
PENGAJUAN_MAKS_DURASI = 90       # hari kalender per pengajuan
PENGAJUAN_MAKS_MAJU_HARI = 365   # tanggal mulai maksimal 1 tahun ke depan
ALASAN_MIN, ALASAN_MAKS = 5, 500
FILTER_PENGAJUAN = ("q", "jenis", "status", "dari", "sampai")


def format_tanggal_waktu(dt):
    d = dt.astimezone(TZ_JAKARTA)
    return f"{d.day} {NAMA_BULAN[d.month - 1][:3]} {d.year}, {d:%H:%M} WIB"


def _indeks_disetujui(pengajuan=None):
    """{id_karyawan: [pengajuan Disetujui]}. pengajuan=None -> data PENGAJUAN global."""
    hasil = {}
    for p in (PENGAJUAN if pengajuan is None else pengajuan):
        if p.get("status") == "Disetujui":
            hasil.setdefault(p["id_karyawan"], []).append(p)
    return hasil


def _disetujui_pada(indeks, kid, tanggal):
    for p in indeks.get(kid, ()):
        if p["mulai"] <= tanggal <= p["selesai"]:
            return p
    return None


def pengajuan_disetujui(kid, tanggal, pengajuan=None):
    """Pengajuan Disetujui milik `kid` yang mencakup `tanggal`, atau None."""
    return _disetujui_pada(_indeks_disetujui(pengajuan), kid, tanggal)


def cari_karyawan_semua(kid):
    """Seperti cari_karyawan tetapi juga karyawan yang sudah dihapus (untuk menampilkan riwayat)."""
    return next((k for k in KARYAWAN if k["id"] == kid), None)


def hitung_hari(mulai, selesai):
    """(hari kalender, hari kerja) pada rentang inklusif."""
    n = (selesai - mulai).days + 1
    kerja = sum(1 for i in range(n) if (mulai + timedelta(days=i)).weekday() in HARI_KERJA)
    return n, kerja


def format_rentang(mulai, selesai):
    if mulai == selesai:
        return format_tanggal_pendek(mulai)
    return f"{format_tanggal_pendek(mulai)} – {format_tanggal_pendek(selesai)}"


def cari_bentrok(kid, mulai, selesai, status_cek=("Menunggu", "Disetujui"), kecuali=None):
    """Pengajuan lain milik karyawan yang sama dengan rentang tanggal beririsan."""
    for p in PENGAJUAN:
        if (p["id_karyawan"] == kid and p["status"] in status_cek and p["id"] != kecuali
                and p["mulai"] <= selesai and p["selesai"] >= mulai):
            return p
    return None


def buat_id_pengajuan():
    angka = [int(m.group(1)) for p in PENGAJUAN if (m := re.fullmatch(r"PGJ-(\d+)", p["id"]))]
    return f"PGJ-{(max(angka) if angka else 0) + 1:04d}"


def validasi_pengajuan(form, hari_ini):
    """Validasi input pengajuan baru di backend (tidak mempercayai browser). Return (nilai, errors).
    Status, tanggal pengajuan, dan pengaju selalu ditentukan server."""
    nilai = {
        "id_karyawan": form.get("id_karyawan", "").strip(),
        "jenis": form.get("jenis", "").strip(),
        "mulai": form.get("mulai", "").strip(),
        "selesai": form.get("selesai", "").strip(),
        "alasan": " ".join(form.get("alasan", "").split()),
    }
    errors = {}
    k = None

    if not nilai["id_karyawan"]:
        errors["id_karyawan"] = "Nama karyawan wajib dipilih."
    else:
        k = cari_karyawan(nilai["id_karyawan"])
        if k is None:
            errors["id_karyawan"] = "Karyawan tidak terdaftar. Pilih nama dari daftar yang tersedia."
        elif k.get("status") != "Aktif":
            errors["id_karyawan"] = f"{k['nama']} berstatus {k['status']} dan tidak dapat dipilih untuk pengajuan baru."
            k = None

    if not nilai["jenis"]:
        errors["jenis"] = "Jenis pengajuan wajib dipilih."
    elif nilai["jenis"] not in JENIS_PENGAJUAN:
        errors["jenis"] = "Jenis pengajuan harus Izin atau Cuti."

    mulai = selesai = None
    if not nilai["mulai"]:
        errors["mulai"] = "Tanggal mulai wajib diisi."
    elif (mulai := _parse_tanggal(nilai["mulai"])) is None:
        errors["mulai"] = "Format tanggal mulai tidak valid."
    if not nilai["selesai"]:
        errors["selesai"] = "Tanggal selesai wajib diisi."
    elif (selesai := _parse_tanggal(nilai["selesai"])) is None:
        errors["selesai"] = "Format tanggal selesai tidak valid."

    if mulai and selesai:
        if selesai < mulai:
            errors["selesai"] = "Tanggal selesai tidak boleh lebih awal daripada tanggal mulai."
        elif (selesai - mulai).days + 1 > PENGAJUAN_MAKS_DURASI:
            errors["selesai"] = f"Durasi pengajuan maksimal {PENGAJUAN_MAKS_DURASI} hari."
    if mulai and "mulai" not in errors:
        if nilai["jenis"] == "Cuti" and mulai < hari_ini:
            errors["mulai"] = "Cuti tidak dapat diajukan untuk tanggal yang sudah lewat."
        elif mulai < hari_ini - timedelta(days=IZIN_MUNDUR_MAKS_HARI):
            errors["mulai"] = f"Izin hanya dapat diajukan mundur maksimal {IZIN_MUNDUR_MAKS_HARI} hari."
        elif mulai > hari_ini + timedelta(days=PENGAJUAN_MAKS_MAJU_HARI):
            errors["mulai"] = "Tanggal mulai terlalu jauh ke depan (maksimal 1 tahun)."

    if not nilai["alasan"]:
        errors["alasan"] = "Alasan pengajuan wajib diisi."
    elif len(nilai["alasan"]) < ALASAN_MIN:
        errors["alasan"] = f"Alasan minimal {ALASAN_MIN} karakter."
    elif len(nilai["alasan"]) > ALASAN_MAKS:
        errors["alasan"] = f"Alasan maksimal {ALASAN_MAKS} karakter."

    if k and mulai and selesai and not errors:
        b = cari_bentrok(k["id"], mulai, selesai)
        if b:
            errors["mulai"] = (f"Bertabrakan dengan pengajuan {b['id']} ({b['jenis']}, "
                               f"{format_rentang(b['mulai'], b['selesai'])}) yang berstatus {b['status']}.")
    nilai["_mulai"], nilai["_selesai"] = mulai, selesai
    return nilai, errors


def parse_filter_pengajuan(args):
    """Filter dari query string. Return (filter, daftar_error)."""
    errors = []
    q = " ".join(args.get("q", "").split())[:100]
    jenis = args.get("jenis", "").strip()
    status = args.get("status", "").strip()
    jenis = jenis if jenis in JENIS_PENGAJUAN else ""
    status = status if status in STATUS_PENGAJUAN else ""
    dari_s, sampai_s = args.get("dari", "").strip(), args.get("sampai", "").strip()
    dari = _parse_tanggal(dari_s) if dari_s else None
    sampai = _parse_tanggal(sampai_s) if sampai_s else None
    if dari_s and dari is None:
        errors.append("Format tanggal awal tidak valid.")
    if sampai_s and sampai is None:
        errors.append("Format tanggal akhir tidak valid.")
    if dari and sampai and dari > sampai:
        errors.append("Tanggal awal tidak boleh melebihi tanggal akhir.")
    return {"q": q, "jenis": jenis, "status": status, "dari": dari, "sampai": sampai}, errors


def _args_pengajuan(f):
    return {
        "q": f["q"] or None, "jenis": f["jenis"] or None, "status": f["status"] or None,
        "dari": f["dari"].isoformat() if f["dari"] else None,
        "sampai": f["sampai"].isoformat() if f["sampai"] else None,
    }


def ringkasan_pengajuan(pengajuan):
    """Hitung dari data aktual (semua pengajuan, tidak terpengaruh filter)."""
    return {
        "total": len(pengajuan),
        "menunggu": sum(1 for p in pengajuan if p["status"] == "Menunggu"),
        "disetujui": sum(1 for p in pengajuan if p["status"] == "Disetujui"),
        "ditolak": sum(1 for p in pengajuan if p["status"] == "Ditolak"),
    }


def bangun_pengajuan(pengajuan, karyawan, f):
    """Baris tabel (terbaru di atas) setelah semua filter diterapkan bersamaan.
    Nama/jabatan dibaca dari data karyawan saat ini (termasuk yang sudah dihapus)."""
    by_id = {k["id"]: k for k in karyawan}
    kw = f["q"].lower()
    rows = []
    for p in pengajuan:
        k = by_id.get(p["id_karyawan"])
        nama = k["nama"] if k else p["id_karyawan"]
        if kw and kw not in nama.lower() and kw not in p["id_karyawan"].lower():
            continue
        if f["jenis"] and p["jenis"] != f["jenis"]:
            continue
        if f["status"] and p["status"] != f["status"]:
            continue
        if f["dari"] and p["selesai"] < f["dari"]:       # rentang pengajuan beririsan dengan filter tanggal
            continue
        if f["sampai"] and p["mulai"] > f["sampai"]:
            continue
        n, kerja = hitung_hari(p["mulai"], p["selesai"])
        rows.append({
            **p, "nama": nama, "jabatan": k.get("jabatan", "") if k else "",
            "karyawan_status": ("Dihapus" if k.get("dihapus") else k.get("status", "")) if k else "",
            "durasi": n, "hari_kerja": kerja,
        })
    rows.sort(key=lambda r: (r["diajukan"], r["id"]), reverse=True)
    return rows


def _detail(r):
    """Versi teks satu pengajuan untuk modal Detail (JSON di halaman; diisi via textContent)."""
    return {
        "id": r["id"], "id_karyawan": r["id_karyawan"], "nama": r["nama"], "jabatan": r["jabatan"] or "—",
        "karyawan_status": r["karyawan_status"], "jenis": r["jenis"], "status": r["status"],
        "mulai": format_tanggal_id(r["mulai"]), "selesai": format_tanggal_id(r["selesai"]),
        "durasi": f"{r['durasi']} hari kalender ({r['hari_kerja']} hari kerja)",
        "alasan": r["alasan"], "diajukan": format_tanggal_waktu(r["diajukan"]),
        "diajukan_oleh": r.get("diajukan_oleh") or "—",
        "diproses_oleh": r.get("diproses_oleh") or "", "diproses_pada": format_tanggal_waktu(r["diproses_pada"]) if r.get("diproses_pada") else "",
        "alasan_penolakan": r.get("alasan_penolakan") or "",
    }


def render_pengajuan(args, modal=None, status_code=200):
    f, errors = parse_filter_pengajuan(args)
    rows = [] if errors else bangun_pengajuan(PENGAJUAN, KARYAWAN, f)
    pilihan = sorted((k for k in karyawan_terlihat() if k.get("status") == "Aktif"), key=lambda k: k["nama"].lower())
    html = render_template(
        "pengajuan.html",
        data=rows, detail={r["id"]: _detail(r) for r in rows}, ringkasan=ringkasan_pengajuan(PENGAJUAN),
        f=f, errors=errors, qs=urlencode({k: v for k, v in _args_pengajuan(f).items() if v}),
        filter_aktif=any((f["q"], f["jenis"], f["status"], f["dari"], f["sampai"])),
        karyawan_aktif=pilihan, jenis_list=JENIS_PENGAJUAN, status_list=STATUS_PENGAJUAN,
        is_admin=session.get("user") in ADMIN_USERS, modal=modal,
        format_tanggal=format_tanggal_pendek, format_waktu=format_tanggal_waktu, active="pengajuan",
    )
    return html, status_code


def admin_required(f):
    """Login + hak admin. Dicek di backend; menyembunyikan tombol di HTML saja tidak cukup."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user" not in session:
            return redirect(url_for("login"))
        if session["user"] not in ADMIN_USERS:
            flash("Anda tidak memiliki hak akses admin untuk tindakan ini.", "error")
            return render_pengajuan({}, status_code=403)
        return f(*args, **kwargs)
    return wrapper


def _filter_dari_form():
    """Filter halaman yang dibawa form (hidden 'qs') agar tampilan tidak reset setelah aksi."""
    pairs = parse_qsl(request.form.get("qs", "")[:500])
    return {k: v for k, v in pairs if k in FILTER_PENGAJUAN and v}


def _kembali_pengajuan():
    return redirect(url_for("pengajuan", **_filter_dari_form()))


@app.route("/pengajuan")
@login_required
def pengajuan():
    return render_pengajuan(request.args)


@app.route("/pengajuan/buat", methods=["POST"])
@admin_required
def pengajuan_buat():
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali_pengajuan()
    with _kunci_data:  # validasi + cek bentrok + simpan atomik: klik ganda tidak membuat duplikat
        nilai, errors = validasi_pengajuan(request.form, sekarang().date())
        if errors:
            tampil = {k: v for k, v in nilai.items() if not k.startswith("_")}
            return render_pengajuan(_filter_dari_form(), {"mode": "buat", "nilai": tampil, "errors": errors}, 400)
        p = {
            "id": buat_id_pengajuan(), "id_karyawan": nilai["id_karyawan"], "jenis": nilai["jenis"],
            "mulai": nilai["_mulai"], "selesai": nilai["_selesai"], "alasan": nilai["alasan"],
            "diajukan": sekarang(), "diajukan_oleh": session["user"], "status": "Menunggu",
            "diproses_oleh": None, "diproses_pada": None, "alasan_penolakan": "",
        }
        PENGAJUAN.append(p)
    nama = cari_karyawan_semua(p["id_karyawan"])["nama"]
    flash(f"Pengajuan {p['jenis']} {p['id']} untuk {nama} berhasil dikirim dan menunggu persetujuan.", "success")
    return _kembali_pengajuan()


def _ambil_menunggu(pid):
    """Return (pengajuan, None) bila ada dan masih Menunggu; selain itu (None, pesan_error)."""
    p = next((x for x in PENGAJUAN if x["id"] == pid), None)
    if p is None:
        return None, "Pengajuan tidak ditemukan."
    if p["status"] != "Menunggu":
        return None, f"Pengajuan {p['id']} sudah berstatus {p['status']} dan tidak dapat diproses ulang."
    return p, None


def _catat_keputusan(p, status, alasan_tolak=""):
    p["status"] = status
    p["diproses_oleh"] = session["user"]
    p["diproses_pada"] = sekarang()
    p["alasan_penolakan"] = alasan_tolak


@app.route("/pengajuan/<pid>/setujui", methods=["POST"])
@admin_required
def pengajuan_setujui(pid):
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali_pengajuan()
    with _kunci_data:
        p, err = _ambil_menunggu(pid)
        if err is None:
            k = cari_karyawan_semua(p["id_karyawan"])
            b = cari_bentrok(p["id_karyawan"], p["mulai"], p["selesai"], ("Disetujui",), kecuali=p["id"])
            if k is None or k.get("dihapus") or k.get("status") == "Nonaktif":
                err = "Karyawan sudah Nonaktif/dihapus, pengajuan tidak dapat disetujui. Tolak pengajuan ini bila perlu."
            elif b:
                err = f"Bertabrakan dengan pengajuan {b['id']} yang sudah disetujui."
        if err:
            flash(err, "error")
            return _kembali_pengajuan()
        _catat_keputusan(p, "Disetujui")
    flash(f"Pengajuan {p['jenis']} {p['id']} ({k['nama']}) disetujui.", "success")
    return _kembali_pengajuan()


@app.route("/pengajuan/<pid>/tolak", methods=["POST"])
@admin_required
def pengajuan_tolak(pid):
    if not _csrf_ok():
        flash("Sesi formulir tidak valid. Muat ulang halaman lalu coba lagi.", "error")
        return _kembali_pengajuan()
    alasan = " ".join(request.form.get("alasan_penolakan", "").split())
    with _kunci_data:
        p, err = _ambil_menunggu(pid)
        if err:
            flash(err, "error")
            return _kembali_pengajuan()
        pesan = ("Alasan penolakan wajib diisi." if not alasan
                 else f"Alasan penolakan maksimal {ALASAN_MAKS} karakter." if len(alasan) > ALASAN_MAKS else "")
        if pesan:
            return render_pengajuan(_filter_dari_form(), {"mode": "tolak", "id": p["id"], "alasan": alasan, "error": pesan}, 400)
        _catat_keputusan(p, "Ditolak", alasan)
    flash(f"Pengajuan {p['jenis']} {p['id']} ({cari_karyawan_semua(p['id_karyawan'])['nama']}) ditolak.", "success")
    return _kembali_pengajuan()


# ---------- LAPORAN ABSENSI ----------
# Tidak punya sumber data sendiri: seluruh baris laporan berasal dari
# bangun_riwayat() (KARYAWAN + LOG_ABSENSI + PENGAJUAN yang sama dengan Dashboard,
# Absensi Harian, Riwayat, dan Pengajuan). Satu baris = satu karyawan pada satu hari.
#
# Definisi (konsisten dengan Riwayat Absensi):
#   Hadir       : baris yang punya Check In (termasuk yang Terlambat). Satuan: karyawan x hari.
#   Terlambat   : baris dengan Check In setelah JAM_BATAS_TEPAT_WAKTU (bagian dari Hadir).
#   Izin / Cuti : pengajuan berstatus DISETUJUI yang mencakup tanggal itu (belum absen).
#   Tidak Hadir : karyawan Aktif, hari kerja <= hari ini, tanpa Check In dan tanpa izin/cuti disetujui.
#   Total Karyawan: karyawan unik yang relevan = karyawan Aktif/Cuti (belum dihapus) yang cocok
#                   dengan filter karyawan/pencarian + karyawan lain (Nonaktif/dihapus) yang punya
#                   baris pada periode. Tidak terpengaruh filter status absensi.
# Distribusi status memakai kategori yang saling lepas: "Hadir" di grafik = Hadir tepat waktu.
STATUS_LAPORAN = ("Hadir", "Terlambat", "Izin", "Cuti", "Tidak Hadir")
PERIODE_LAPORAN = (("hari_ini", "Hari Ini"), ("minggu_ini", "Minggu Ini"),
                   ("bulan_ini", "Bulan Ini"), ("rentang", "Rentang Tanggal"))
NAMA_PERIODE = dict(PERIODE_LAPORAN)
PER_PAGE_LAPORAN = 20
LAPORAN_MAKS_HARI = RENTANG_MAKS_HARI
KOLOM_LAPORAN = ["No.", "Tanggal", "ID Karyawan", "Nama Karyawan", "Jabatan",
                 "Jam Datang", "Jam Pulang", "Status Absensi", "Keterangan"]


def rentang_periode(periode, hari_ini):
    """(dari, sampai) untuk periode preset. Minggu = Senin-Minggu, bulan = tanggal 1-akhir bulan."""
    if periode == "hari_ini":
        return hari_ini, hari_ini
    if periode == "minggu_ini":
        senin = hari_ini - timedelta(days=hari_ini.weekday())
        return senin, senin + timedelta(days=6)
    akhir = calendar.monthrange(hari_ini.year, hari_ini.month)[1]
    return hari_ini.replace(day=1), hari_ini.replace(day=akhir)


def parse_filter_laporan(args, hari_ini):
    """Baca + validasi filter dari query string. Return (filter, daftar_error)."""
    errors = []
    mentah_dari, mentah_sampai = args.get("dari", "").strip(), args.get("sampai", "").strip()
    periode = args.get("periode", "").strip()
    if periode not in NAMA_PERIODE:
        periode = "rentang" if (mentah_dari or mentah_sampai) else "bulan_ini"  # default: bulan berjalan

    if periode == "rentang":
        sampai = _parse_tanggal(mentah_sampai) if mentah_sampai else hari_ini
        if sampai is None:
            errors.append("Format tanggal selesai tidak valid.")
            sampai = hari_ini
        dari = _parse_tanggal(mentah_dari) if mentah_dari else sampai.replace(day=1)
        if dari is None:
            errors.append("Format tanggal mulai tidak valid.")
            dari = sampai.replace(day=1)
        if not errors:
            if dari > sampai:
                errors.append("Tanggal selesai tidak boleh lebih awal daripada tanggal mulai.")
            elif (sampai - dari).days + 1 > LAPORAN_MAKS_HARI:
                errors.append(f"Rentang tanggal maksimal {LAPORAN_MAKS_HARI} hari.")
    else:
        dari, sampai = rentang_periode(periode, hari_ini)

    kid = args.get("karyawan", "").strip()
    if kid and cari_karyawan_semua(kid) is None:
        errors.append("Karyawan yang dipilih tidak ditemukan.")
        kid = ""
    status = args.get("status", "").strip()
    if status not in STATUS_LAPORAN:
        status = ""
    q = " ".join(args.get("q", "").split())[:100]
    return {"periode": periode, "dari": dari, "sampai": sampai, "karyawan": kid, "status": status, "q": q}, errors


def bangun_laporan(karyawan, log_absensi, f, hari_ini, pengajuan=None):
    """Return (baris_laporan, total_karyawan_relevan). Memakai bangun_riwayat (satu baris per
    karyawan per hari, tidak ada JOIN ganda). Filter karyawan memakai ID persis."""
    kw = f["q"].lower()
    kar = [
        k for k in karyawan
        if (not f["karyawan"] or k["id"] == f["karyawan"])
        and (not kw or kw in k["id"].lower() or kw in k["nama"].lower())
    ]
    semua = bangun_riwayat(kar, log_absensi, f["dari"], f["sampai"], hari_ini, "", "", pengajuan)
    relevan = {r["id"] for r in semua} | {
        k["id"] for k in kar if k.get("status") in ("Aktif", "Cuti") and not k.get("dihapus")
    }
    for r in semua:
        r["label"] = "Hadir" if r["status"] == "Tepat Waktu" else r["status"]
    if f["status"] == "Hadir":
        rows = [r for r in semua if r["datang"] is not None]
    elif f["status"]:
        rows = [r for r in semua if r["status"] == f["status"]]
    else:
        rows = semua
    return rows, len(relevan)


def statistik_laporan(rows, total_karyawan):
    hadir = [r for r in rows if r["datang"] is not None]
    terlambat = [r for r in rows if r["status"] == "Terlambat"]
    tidak = [r for r in rows if r["status"] == "Tidak Hadir"]
    jumlah = {s: sum(1 for r in rows if r["label"] == s) for s in STATUS_LAPORAN}
    total = len(rows)
    distribusi = [
        {"label": s, "jumlah": jumlah[s], "persen": (jumlah[s] * 100 / total) if total else 0}
        for s in STATUS_LAPORAN
    ]
    return {
        "karyawan": total_karyawan,
        "hadir": len(hadir), "hadir_unik": len({r["id"] for r in hadir}),
        "terlambat": len(terlambat), "terlambat_unik": len({r["id"] for r in terlambat}),
        "tidak_hadir": len(tidak), "tidak_hadir_unik": len({r["id"] for r in tidak}),
        "izin": jumlah["Izin"], "cuti": jumlah["Cuti"],
        "total_baris": total, "distribusi": distribusi,
    }


def data_tren(rows, f, hari_ini):
    """Seri harian untuk grafik: jumlah karyawan Hadir (termasuk terlambat) dan Terlambat per tanggal.
    Hanya hari kerja (atau hari yang punya catatan) sampai hari ini; kosong jika tidak ada baris."""
    kosong = {"label": [], "penuh": [], "hadir": [], "terlambat": []}
    if not rows:
        return kosong
    per_hari = {}
    for r in rows:
        d = per_hari.setdefault(r["tanggal"], [0, 0])
        if r["datang"] is not None:
            d[0] += 1
        if r["status"] == "Terlambat":
            d[1] += 1
    tren = {"label": [], "penuh": [], "hadir": [], "terlambat": []}
    hari, batas = f["dari"], min(f["sampai"], hari_ini)
    while hari <= batas:
        if hari.weekday() in HARI_KERJA or hari in per_hari:
            h, t = per_hari.get(hari, (0, 0))
            tren["label"].append(f"{hari.day} {NAMA_BULAN[hari.month - 1][:3]}")
            tren["penuh"].append(format_tanggal_pendek(hari))
            tren["hadir"].append(h)
            tren["terlambat"].append(t)
        hari += timedelta(days=1)
    return tren


def _args_laporan(f):
    """Query string filter yang dibawa tautan pagination/ekspor/cetak (None = dibuang)."""
    a = {"periode": f["periode"], "karyawan": f["karyawan"] or None,
         "status": f["status"] or None, "q": f["q"] or None}
    if f["periode"] == "rentang":
        a["dari"], a["sampai"] = f["dari"].isoformat(), f["sampai"].isoformat()
    return a


def pilihan_karyawan_laporan():
    """Dropdown karyawan: semua karyawan terlihat + karyawan terhapus yang punya riwayat absensi."""
    punya_log = {r.get("id_karyawan") for r in LOG_ABSENSI}
    hasil = []
    for k in sorted(KARYAWAN, key=lambda k: k["nama"].lower()):
        if k.get("dihapus") and k["id"] not in punya_log:
            continue
        akhiran = " — Dihapus" if k.get("dihapus") else " — Nonaktif" if k.get("status") == "Nonaktif" else ""
        hasil.append({"id": k["id"], "label": f"{k['nama']} ({k['id']}){akhiran}"})
    return hasil


def _konteks_laporan(args):
    hari_ini = sekarang().date()
    f, errors = parse_filter_laporan(args, hari_ini)
    rows, total_kar = ([], 0) if errors else bangun_laporan(KARYAWAN, LOG_ABSENSI, f, hari_ini)
    return hari_ini, f, errors, rows, statistik_laporan(rows, total_kar), data_tren(rows, f, hari_ini)


def _ringkasan_filter(f):
    k = cari_karyawan_semua(f["karyawan"]) if f["karyawan"] else None
    return [
        ("Periode", f"{NAMA_PERIODE[f['periode']]}: {format_rentang(f['dari'], f['sampai'])}"),
        ("Karyawan", f"{k['nama']} ({k['id']})" if k else "Semua Karyawan"),
        ("Status", f["status"] or "Semua Status"),
        ("Pencarian", f["q"] or "-"),
    ]


def _jam_atau_strip(w):
    return w.strftime("%H:%M") if w else "-"


@app.route("/laporan")
@login_required
def laporan():
    hari_ini, f, errors, rows, stats, tren = _konteks_laporan(request.args)
    total = len(rows)
    jumlah_hal = max(1, math.ceil(total / PER_PAGE_LAPORAN))
    page = min(max(request.args.get("page", 1, type=int) or 1, 1), jumlah_hal)
    mulai = (page - 1) * PER_PAGE_LAPORAN
    data = rows[mulai:mulai + PER_PAGE_LAPORAN]
    return render_template(
        "laporan.html",
        f=f, errors=errors, data=data, total=total, stats=stats, tren=tren,
        page=page, jumlah_hal=jumlah_hal, halaman=daftar_halaman(page, jumlah_hal),
        awal=mulai + 1 if data else 0, akhir=mulai + len(data), nomor_awal=mulai,
        args=_args_laporan(f), hari_ini=hari_ini,
        filter_aktif=bool(f["karyawan"] or f["status"] or f["q"]),
        periode_list=PERIODE_LAPORAN, status_list=STATUS_LAPORAN,
        karyawan_list=pilihan_karyawan_laporan(),
        periode_teks=format_rentang(f["dari"], f["sampai"]),
        format_tanggal=format_tanggal_pendek, active="laporan",
    )


def _kembali_laporan_error(errors):
    for e in errors:
        flash(e, "error")
    return redirect(url_for("laporan", **{k: v for k, v in request.args.items() if k != "page"}))


def _csv_laporan(f, rows, stats, waktu):
    buf = io.StringIO()
    t = csv.writer(buf)
    t.writerow(["Laporan Absensi"])
    for nama, nilai in _ringkasan_filter(f):
        t.writerow([nama, nilai])
    t.writerow(["Diekspor pada", waktu])
    t.writerow(["Total Karyawan", stats["karyawan"]])
    t.writerow(["Total Hadir (karyawan x hari)", stats["hadir"]])
    t.writerow(["Total Terlambat", stats["terlambat"]])
    t.writerow(["Total Tidak Hadir", stats["tidak_hadir"]])
    t.writerow(["Izin", stats["izin"]])
    t.writerow(["Cuti", stats["cuti"]])
    t.writerow([])
    t.writerow(KOLOM_LAPORAN)
    for i, r in enumerate(rows, 1):
        t.writerow([
            i, r["tanggal"].isoformat(), _sel_csv(r["id"]), _sel_csv(r["nama"]), _sel_csv(r["jabatan"]),
            _jam_atau_strip(r["datang"]), _jam_atau_strip(r["pulang"]), r["label"], _sel_csv(r["keterangan"]),
        ])
    return "﻿" + buf.getvalue()  # BOM agar Excel membaca UTF-8


def _xlsx_laporan(f, rows, stats, waktu):
    """Bangun file .xlsx (butuh openpyxl). Teks yang diawali '=' disimpan sebagai teks, bukan rumus."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Laporan Absensi"

    def teks(sel, nilai):
        sel.value = nilai
        if isinstance(nilai, str):
            sel.data_type = "s"
        return sel

    ws["A1"] = "Laporan Absensi"
    ws["A1"].font = Font(bold=True, size=14)
    baris = 2
    for nama, nilai in _ringkasan_filter(f) + [("Diekspor pada", waktu)]:
        ws.cell(baris, 1, nama).font = Font(bold=True)
        teks(ws.cell(baris, 2), nilai)
        baris += 1
    ringkas = [("Total Karyawan", stats["karyawan"]), ("Total Hadir (karyawan x hari)", stats["hadir"]),
               ("Total Terlambat", stats["terlambat"]), ("Total Tidak Hadir", stats["tidak_hadir"]),
               ("Izin", stats["izin"]), ("Cuti", stats["cuti"])]
    for nama, nilai in ringkas:
        ws.cell(baris, 1, nama).font = Font(bold=True)
        ws.cell(baris, 2, nilai).alignment = Alignment(horizontal="left")
        baris += 1

    baris += 1
    header = baris
    garis = Side(style="thin", color="D1D5DB")
    for c, nama in enumerate(KOLOM_LAPORAN, 1):
        s = ws.cell(header, c, nama)
        s.font = Font(bold=True, color="FFFFFF")
        s.fill = PatternFill("solid", fgColor="2563EB")
        s.alignment = Alignment(horizontal="center", vertical="center")
        s.border = Border(top=garis, bottom=garis, left=garis, right=garis)
    for i, r in enumerate(rows, 1):
        n = header + i
        ws.cell(n, 1, i)
        d = ws.cell(n, 2, r["tanggal"])
        d.number_format = "yyyy-mm-dd"
        d.alignment = Alignment(horizontal="left")
        for c, nilai in ((3, r["id"]), (4, r["nama"]), (5, r["jabatan"]),
                         (6, _jam_atau_strip(r["datang"])), (7, _jam_atau_strip(r["pulang"])),
                         (8, r["label"]), (9, r["keterangan"])):
            teks(ws.cell(n, c), nilai)
        for c in range(1, 10):
            ws.cell(n, c).border = Border(top=garis, bottom=garis, left=garis, right=garis)
    lebar = [6, 13, 13, 24, 22, 12, 12, 16, 40]
    for c, w in enumerate(lebar, 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.column_dimensions["A"].width = 30  # kolom A juga memuat label ringkasan di atas tabel
    ws.auto_filter.ref = f"A{header}:I{header + max(len(rows), 1)}"
    ws.print_title_rows = f"{header}:{header}"
    ws.page_setup.orientation = "landscape"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


@app.route("/laporan/export/<fmt>")
@login_required
def laporan_export(fmt):
    """Ekspor seluruh hasil filter aktif (bukan hanya halaman yang terlihat): csv atau xlsx."""
    if fmt not in ("csv", "xlsx"):
        abort(404)
    hari_ini, f, errors, rows, stats, _ = _konteks_laporan(request.args)
    if errors:
        return _kembali_laporan_error(errors)
    waktu = format_tanggal_waktu(sekarang())
    nama_file = f"laporan_absensi_{f['dari'].isoformat()}_{f['sampai'].isoformat()}.{fmt}"
    headers = {"Content-Disposition": f'attachment; filename="{nama_file}"'}
    if fmt == "csv":
        return Response(_csv_laporan(f, rows, stats, waktu), mimetype="text/csv; charset=utf-8", headers=headers)
    try:
        isi = _xlsx_laporan(f, rows, stats, waktu)
    except ImportError:
        flash("Ekspor Excel membutuhkan library openpyxl. Jalankan: pip install openpyxl", "error")
        return redirect(url_for("laporan", **{k: v for k, v in request.args.items() if k != "page"}))
    return Response(isi, headers=headers,
                    mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/laporan/cetak")
@login_required
def laporan_cetak():
    """Halaman siap cetak (Ctrl+P / Simpan sebagai PDF) berisi seluruh hasil filter aktif."""
    hari_ini, f, errors, rows, stats, _ = _konteks_laporan(request.args)
    if errors:
        return _kembali_laporan_error(errors)
    return render_template(
        "laporan_cetak.html", f=f, rows=rows, stats=stats, filter_info=_ringkasan_filter(f),
        waktu_cetak=format_tanggal_waktu(sekarang()), format_tanggal=format_tanggal_pendek,
        args=_args_laporan(f),
    )


if __name__ == "__main__":
    app.run(debug=True)