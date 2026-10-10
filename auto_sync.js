const { exec } = require('child_process');
const fs = require('fs');

console.log('====================================================');
console.log('  CHE DO TU DONG DONG BO LEN GITHUB & RENDER DANG CHAY');
console.log('  Moi khi ban luu file, he thong se tu dong push len!');
console.log('====================================================');

let timeoutId = null;

function doSync() {
  const time = new Date().toLocaleTimeString('vi-VN');
  console.log(`[${time}] Phat hien thay doi. Dang tu dong day len GitHub & Render...`);
  exec('git add . && git commit -m "Auto sync: ' + time + '" && git push', (err, stdout, stderr) => {
    if (err) {
      console.error('[Loi đồng bộ]:', err.message);
    } else {
      console.log(`[${time}] [OK] Da dong bo thanh cong! Render dang deploy.`);
    }
  });
}

// Theo doi su thay doi file
fs.watch(__dirname, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (filename.startsWith('.git') || filename.includes('node_modules')) return;
  
  clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    doSync();
  }, 3000); // Đợi 3 giây sau khi bạn lưu file để tự động push
});
