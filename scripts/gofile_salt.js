// Ekstrak salt WT live dari gofile.io/js/wt.obf.js dengan MENJALANKAN
// generateWT() aslinya (stub _sha256 agar mengembalikan dataToHash mentah).
// Jauh lebih tahan rotasi obfuskasi dibanding analisis statis.
//
// Usage:
//   node scripts/gofile_salt.js [url_js]
//   node scripts/gofile_salt.js https://gofile.io/js/wt.obf.js
//
// Output: baris "LIVE SALT: <salt>". Butuh node saja (tanpa dependensi).
// Jalankan dari jaringan yang TIDAK diblokir Gofile; cukup sesekali karena
// salt hanya diputar Gofile dari waktu ke waktu.
const https = require("https");

const URL = process.argv[2] || "https://gofile.io/js/wt.obf.js";

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error("HTTP " + res.statusCode));
            return;
          }
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        }
      )
      .on("error", reject);
  });
}

(async () => {
  const arg = process.argv[2] || URL;
  const src = /^https?:/.test(arg)
    ? await fetch(arg)
    : require("fs").readFileSync(arg, "utf-8");
  global.navigator = { userAgent: "UA-TEST", language: "en-US" };
  eval(
    src +
      '\n_sha256 = (x) => "HASHINPUT::" + x;\nglobal.__out = generateWT("T");'
  );
  const parts = String(global.__out).replace("HASHINPUT::", "").split("::");
  if (parts.length < 5) {
    console.error("PARSE-FAIL:", global.__out);
    process.exit(1);
  }
  console.log("LIVE SALT:", parts[4]);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
