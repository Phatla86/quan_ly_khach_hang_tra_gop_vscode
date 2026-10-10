/**
 * Server Quản Lý Khách Hàng Mua Máy & Trả Góp
 * Chạy độc lập bằng Node.js tiêu chuẩn (Không cần cài thêm thư viện ngoài)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const HTML_FILE = path.join(__dirname, 'index.html');

// Đọc dữ liệu từ file database.json
function readDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, '[]', 'utf8');
      return [];
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Lỗi đọc database.json:', err);
    return [];
  }
}

// Lưu dữ liệu vào file database.json
function writeDatabase(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Lỗi ghi database.json:', err);
    return false;
  }
}

// Hàm gửi phản hồi JSON
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Hàm đọc body của request POST/PUT
function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (e) {
      callback(e, null);
    }
  });
}

// Khởi tạo máy chủ HTTP
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Xử lý CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // API: Lấy danh sách khách hàng
  if (pathname === '/api/customers' && method === 'GET') {
    const customers = readDatabase();
    return sendJSON(res, 200, customers);
  }

  // API: Thêm khách hàng mới
  if (pathname === '/api/customers' && method === 'POST') {
    return parseBody(req, (err, newCustomer) => {
      if (err) return sendJSON(res, 400, { error: 'Dữ liệu không hợp lệ' });
      const customers = readDatabase();
      if (!newCustomer.id) {
        newCustomer.id = 'KH_' + Date.now();
      }
      customers.unshift(newCustomer);
      writeDatabase(customers);
      console.log(`[Thêm mới] Khách hàng: ${newCustomer.name} (${newCustomer.model})`);
      return sendJSON(res, 201, newCustomer);
    });
  }

  // API: Cập nhật thông tin khách hàng
  if (pathname.startsWith('/api/customers/') && method === 'PUT') {
    const id = pathname.split('/')[3];
    return parseBody(req, (err, updatedData) => {
      if (err) return sendJSON(res, 400, { error: 'Dữ liệu không hợp lệ' });
      const customers = readDatabase();
      const index = customers.findIndex(c => c.id === id);
      if (index === -1) return sendJSON(res, 404, { error: 'Không tìm thấy khách hàng' });

      customers[index] = { ...customers[index], ...updatedData, id };
      writeDatabase(customers);
      console.log(`[Cập nhật] Khách hàng ID: ${id}`);
      return sendJSON(res, 200, customers[index]);
    });
  }

  // API: Xóa khách hàng
  if (pathname.startsWith('/api/customers/') && method === 'DELETE') {
    const id = pathname.split('/')[3];
    let customers = readDatabase();
    customers = customers.filter(c => c.id !== id);
    writeDatabase(customers);
    console.log(`[Xóa] Khách hàng ID: ${id}`);
    return sendJSON(res, 200, { success: true, message: 'Đã xóa khách hàng' });
  }

  // API: Thu tiền hoặc Hủy thu một kỳ trả góp
  if (pathname.match(/^\/api\/customers\/([^\/]+)\/pay$/) && method === 'POST') {
    const id = pathname.split('/')[3];
    return parseBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'Dữ liệu không hợp lệ' });
      const { term, action } = body; // action: 'pay' hoặc 'undo'
      const customers = readDatabase();
      const customer = customers.find(c => c.id === id);
      if (!customer || !customer.schedule) {
        return sendJSON(res, 404, { error: 'Không tìm thấy lịch trả góp' });
      }

      const termItem = customer.schedule.find(s => s.term === term);
      if (!termItem) {
        return sendJSON(res, 404, { error: 'Không tìm thấy kỳ số ' + term });
      }

      if (action === 'pay') {
        const today = new Date();
        const day = String(today.getDate()).padStart(2, '0');
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const year = today.getFullYear();
        termItem.actualAmount = termItem.amount;
        termItem.paidDate = `${day}/${month}/${year}`;
        termItem.debt = 0;
        termItem.status = 'paid';
      } else {
        termItem.actualAmount = null;
        termItem.paidDate = null;
        termItem.debt = termItem.amount;
        termItem.status = 'upcoming';
      }

      writeDatabase(customers);
      return sendJSON(res, 200, customer);
    });
  }

  // Giao diện Web App chính (index.html)
  if (pathname === '/' || pathname === '/index.html' || pathname === '/app') {
    fs.readFile(HTML_FILE, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Lỗi máy chủ: Không tìm thấy file index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`  HE THONG QUAN LY KHACH HANG TRA GOP DA KHOI DONG!`);
  console.log(`  Truy cap Cuc Bo (Local): http://localhost:${PORT}`);
  console.log(`  Co so du lieu luu tai : ${DB_FILE}`);
  console.log('====================================================');
});
