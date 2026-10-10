/**
 * ==============================================================================
 * RETAIL DEVICE INSTALLMENT MANAGEMENT SYSTEM (CORE BACKEND ENGINE)
 * ==============================================================================
 * Architecture: Senior Enterprise Node.js Service (Zero External Dependencies)
 * Features:
 *   - RESTful API with standardized JSON envelopes
 *   - Atomic file I/O transactions with write-ahead temp file & auto-backup
 *   - Input Sanitization & Strict Type Validation
 *   - Security Headers & CORS origin control
 *   - In-memory rate limiting to prevent abuse
 *   - Render Cloud 24/7 Keep-Alive Background Worker
 *   - Graceful process shutdown handling (SIGINT/SIGTERM)
 * Author: Senior Software Engineer
 * ==============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

// ------------------------------------------------------------------------------
// 1. CONFIGURATION & CONSTANTS
// ------------------------------------------------------------------------------
const CONFIG = {
  PORT: process.env.PORT || 3000,
  DB_PATH: path.join(__dirname, 'database.json'),
  DB_BACKUP_PATH: path.join(__dirname, 'database.backup.json'),
  CLIENT_PATH: path.join(__dirname, 'index.html'),
  MAX_BODY_SIZE: 2 * 1024 * 1024, // 2MB limit
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 120, // 120 requests/min per IP
  RENDER_PING_INTERVAL_MS: 14 * 60 * 1000, // 14 minutes
};

// ------------------------------------------------------------------------------
// 2. DATABASE REPOSITORY SERVICE (Atomic File Storage Engine)
// ------------------------------------------------------------------------------
class DatabaseService {
  constructor(filePath, backupPath) {
    this.filePath = filePath;
    this.backupPath = backupPath;
    this.isWriting = false;
    this.writeQueue = [];
    this.initDatabase();
  }

  initDatabase() {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf8');
      } else {
        // Validate JSON integrity on startup
        const raw = fs.readFileSync(this.filePath, 'utf8');
        JSON.parse(raw);
      }
    } catch (err) {
      console.error('[DB Service] Corrupt database file detected. Attempting recovery...', err.message);
      if (fs.existsSync(this.backupPath)) {
        fs.copyFileSync(this.backupPath, this.filePath);
        console.log('[DB Service] Successfully restored from backup!');
      } else {
        fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf8');
        console.log('[DB Service] Initialized fresh database container.');
      }
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('[DB Service] Error reading database:', err.message);
      return [];
    }
  }

  /**
   * Atomic file write using a temporary swap file to prevent data corruption
   */
  async write(data) {
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ data, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const task = this.writeQueue.shift();

    try {
      const jsonContent = JSON.stringify(task.data, null, 2);
      const tempPath = `${this.filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;

      // 1. Write to temp file
      fs.writeFileSync(tempPath, jsonContent, 'utf8');

      // 2. Atomic rename (Windows & POSIX safe)
      fs.renameSync(tempPath, this.filePath);

      // 3. Update backup snapshot periodically
      try {
        fs.writeFileSync(this.backupPath, jsonContent, 'utf8');
      } catch (_) {}

      task.resolve(true);
    } catch (err) {
      console.error('[DB Service] Atomic write failure:', err.message);
      task.reject(err);
    } finally {
      this.isWriting = false;
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }
}

const db = new DatabaseService(CONFIG.DB_PATH, CONFIG.DB_BACKUP_PATH);

// ------------------------------------------------------------------------------
// 3. VALIDATION & BUSINESS LOGIC ENGINE
// ------------------------------------------------------------------------------
class Validator {
  static sanitizeString(str, defaultValue = '') {
    if (typeof str !== 'string') return defaultValue;
    return str.trim();
  }

  static parseNumber(num, defaultValue = 0) {
    const parsed = parseFloat(num);
    return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
  }

  static validateCustomer(payload) {
    const errors = [];
    const name = this.sanitizeString(payload.name);
    const phone = this.sanitizeString(payload.phone);
    const model = this.sanitizeString(payload.model);
    const price = this.parseNumber(payload.price);
    const deposit = this.parseNumber(payload.deposit);
    const terms = parseInt(payload.terms, 10);
    const monthlyAmount = this.parseNumber(payload.monthlyAmount);

    if (!name) errors.push('Họ tên khách hàng không được để trống.');
    if (!phone) errors.push('Số điện thoại không được để trống.');
    if (!model) errors.push('Model thiết bị không được để trống.');
    if (price <= 0) errors.push('Giá bán máy phải lớn hơn 0.');
    if (deposit < 0) errors.push('Tiền cọc không được nhỏ hơn 0.');
    if (deposit > price) errors.push('Tiền cọc không được lớn hơn giá gốc máy.');
    if (isNaN(terms) || terms < 1) errors.push('Số kỳ trả góp phải lớn hơn hoặc bằng 1.');
    if (monthlyAmount < 0) errors.push('Số tiền mỗi kỳ không hợp lệ.');

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: {
        id: payload.id || `KH_${Date.now()}`,
        name,
        phone,
        model,
        capacity: this.sanitizeString(payload.capacity, '128GB'),
        color: this.sanitizeString(payload.color, 'Titan'),
        imei: this.sanitizeString(payload.imei),
        deviceModel: this.sanitizeString(payload.deviceModel, `${model} - ${payload.color || ''} - ${payload.capacity || ''}`),
        qty: this.sanitizeString(payload.qty, '01'),
        condition: this.sanitizeString(payload.condition, '99%'),
        price,
        deposit,
        terms,
        monthlyAmount,
        startDate: payload.startDate || new Date().toISOString().split('T')[0],
        notes: this.sanitizeString(payload.notes),
        schedule: Array.isArray(payload.schedule) && payload.schedule.length > 0 
          ? payload.schedule 
          : this.generateAmortizationSchedule(terms, monthlyAmount, payload.startDate)
      }
    };
  }

  static generateAmortizationSchedule(terms, monthlyAmount, startDateStr) {
    const schedule = [];
    const baseDate = startDateStr ? new Date(startDateStr) : new Date();

    for (let i = 1; i <= terms; i++) {
      const d = new Date(baseDate);
      d.setMonth(d.getMonth() + i);
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();

      schedule.push({
        term: i,
        dueDate: `${day}/${month}/${year}`,
        amount: monthlyAmount,
        actualAmount: null,
        paidDate: null,
        debt: monthlyAmount,
        status: 'upcoming'
      });
    }
    return schedule;
  }
}

// ------------------------------------------------------------------------------
// 4. SECURITY & RATE LIMITING MIDDLEWARE
// ------------------------------------------------------------------------------
const rateLimitMap = new Map();

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + CONFIG.RATE_LIMIT_WINDOW_MS };
  
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + CONFIG.RATE_LIMIT_WINDOW_MS;
  } else {
    record.count++;
  }
  
  rateLimitMap.set(ip, record);
  return record.count <= CONFIG.RATE_LIMIT_MAX_REQUESTS;
}

// Clean up expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// Helper: Standardized JSON Response Envelope
function sendResponse(res, statusCode, success, data = null, message = '') {
  applySecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    success,
    status: statusCode,
    timestamp: new Date().toISOString(),
    message: message || (success ? 'Thành công' : 'Thất bại'),
    data
  }));
}

// Helper: Request Body Parser
function parseJsonBody(req, callback) {
  let body = '';
  let byteCount = 0;

  req.on('data', chunk => {
    byteCount += chunk.length;
    if (byteCount > CONFIG.MAX_BODY_SIZE) {
      req.destroy();
      callback(new Error('Payload Too Large'), null);
      return;
    }
    body += chunk;
  });

  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (err) {
      callback(new Error('Invalid JSON Body'), null);
    }
  });
}

// ------------------------------------------------------------------------------
// 5. RESTFUL CONTROLLER DISPATCHER
// ------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    applySecurityHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate Limiting
  if (!checkRateLimit(clientIp)) {
    return sendResponse(res, 429, false, null, 'Bạn đang gửi quá nhiều yêu cầu. Vui lòng thử lại sau giây lát.');
  }

  // Log incoming requests
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[HTTP] ${method} ${pathname} -> ${res.statusCode} (${duration}ms)`);
  });

  // ----------------------------------------------------------------------------
  // API ROUTING
  // ----------------------------------------------------------------------------

  // GET /api/customers - Lấy toàn bộ danh sách khách hàng
  if (pathname === '/api/customers' && method === 'GET') {
    const list = db.read();
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(list)); // Return raw list for transparent client compatibility
    return;
  }

  // POST /api/customers - Thêm khách hàng mới
  if (pathname === '/api/customers' && method === 'POST') {
    return parseJsonBody(req, async (err, body) => {
      if (err) return sendResponse(res, 400, false, null, err.message);

      const validation = Validator.validateCustomer(body);
      if (!validation.isValid) {
        return sendResponse(res, 422, false, { errors: validation.errors }, validation.errors[0]);
      }

      const customers = db.read();
      customers.unshift(validation.sanitized);
      await db.write(customers);

      return sendResponse(res, 201, true, validation.sanitized, 'Đã tạo hồ sơ khách hàng thành công.');
    });
  }

  // PUT /api/customers/:id - Cập nhật thông tin khách hàng
  if (pathname.startsWith('/api/customers/') && !pathname.endsWith('/pay') && method === 'PUT') {
    const id = pathname.split('/')[3];
    return parseJsonBody(req, async (err, body) => {
      if (err) return sendResponse(res, 400, false, null, err.message);

      const customers = db.read();
      const index = customers.findIndex(c => c.id === id);
      if (index === -1) {
        return sendResponse(res, 404, false, null, `Không tìm thấy khách hàng với mã: ${id}`);
      }

      const validation = Validator.validateCustomer({ ...body, id });
      if (!validation.isValid) {
        return sendResponse(res, 422, false, { errors: validation.errors }, validation.errors[0]);
      }

      customers[index] = validation.sanitized;
      await db.write(customers);

      return sendResponse(res, 200, true, customers[index], 'Cập nhật thông tin khách hàng thành công.');
    });
  }

  // DELETE /api/customers/:id - Xóa hồ sơ khách hàng
  if (pathname.startsWith('/api/customers/') && method === 'DELETE') {
    const id = pathname.split('/')[3];
    let customers = db.read();
    const beforeCount = customers.length;
    customers = customers.filter(c => c.id !== id);

    if (customers.length === beforeCount) {
      return sendResponse(res, 404, false, null, `Không tìm thấy khách hàng với mã: ${id}`);
    }

    await db.write(customers);
    return sendResponse(res, 200, true, { id }, 'Đã xóa hồ sơ khách hàng.');
  }

  // POST /api/customers/:id/pay - Ghi nhận hoặc Hủy thu một kỳ trả góp
  if (pathname.match(/^\/api\/customers\/([^\/]+)\/pay$/) && method === 'POST') {
    const id = pathname.split('/')[3];
    return parseJsonBody(req, async (err, body) => {
      if (err) return sendResponse(res, 400, false, null, err.message);

      const { term, action } = body;
      const termNumber = parseInt(term, 10);
      if (isNaN(termNumber) || termNumber < 1) {
        return sendResponse(res, 400, false, null, 'Số kỳ không hợp lệ.');
      }

      const customers = db.read();
      const customer = customers.find(c => c.id === id);
      if (!customer || !Array.isArray(customer.schedule)) {
        return sendResponse(res, 404, false, null, 'Không tìm thấy hồ sơ hoặc lịch trả góp của khách hàng.');
      }

      const termItem = customer.schedule.find(s => s.term === termNumber);
      if (!termItem) {
        return sendResponse(res, 404, false, null, `Không tìm thấy kỳ hạn thanh toán số ${termNumber}.`);
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

      await db.write(customers);
      return sendResponse(res, 200, true, customer, `Đã ${action === 'pay' ? 'thu tiền' : 'hủy thu'} kỳ số ${termNumber}.`);
    });
  }

  // GET /api/download-db - Xuất tải file database.json trực tiếp từ server
  if (pathname === '/api/download-db' && method === 'GET') {
    const data = db.read();
    applySecurityHeaders(res);
    res.setHeader('Content-Disposition', 'attachment; filename="database.json"');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // GET /api/health - Healthcheck Endpoint
  if (pathname === '/api/health' && method === 'GET') {
    return sendResponse(res, 200, true, {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }, 'Hệ thống hoạt động bình thường.');
  }

  // ----------------------------------------------------------------------------
  // STATIC CLIENT SERVING (INDEX.HTML)
  // ----------------------------------------------------------------------------
  if (pathname === '/' || pathname === '/index.html' || pathname === '/app') {
    fs.readFile(CONFIG.CLIENT_PATH, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Lỗi máy chủ: Không thể đọc file giao diện index.html');
        return;
      }
      applySecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // Fallback 404
  return sendResponse(res, 404, false, null, 'Đường dẫn yêu cầu không tồn tại.');
});

// ------------------------------------------------------------------------------
// 6. RENDER CLOUD 24/7 KEEP-ALIVE WORKER
// ------------------------------------------------------------------------------
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  const https = require('https');
  console.log(`[Keep-Alive] Đã kích hoạt cơ chế tự giữ server thức 24/24: ${RENDER_EXTERNAL_URL}`);
  setInterval(() => {
    https.get(RENDER_EXTERNAL_URL, (res) => {
      console.log(`[Keep-Alive] Ping duy trì thành công lúc ${new Date().toISOString()}`);
    }).on('error', (err) => {
      console.error('[Keep-Alive] Lỗi ping:', err.message);
    });
  }, CONFIG.RENDER_PING_INTERVAL_MS);
}

// ------------------------------------------------------------------------------
// 7. SERVER INITIALIZATION & GRACEFUL SHUTDOWN
// ------------------------------------------------------------------------------
server.listen(CONFIG.PORT, () => {
  console.log('================================================================');
  console.log('  HỆ THỐNG QUẢN LÝ KHÁCH HÀNG MUA MÁY & TRẢ GÓP (NODE.JS CORE)');
  console.log(`  Local Endpoint : http://localhost:${CONFIG.PORT}`);
  console.log(`  Database File  : ${CONFIG.DB_PATH}`);
  console.log('  Architecture   : Zero-Dependency Enterprise HTTP Service');
  console.log('================================================================');
});

// Graceful process shutdown handling
function handleGracefulShutdown(signal) {
  console.log(`\n[Server] Nhận tín hiệu ${signal}. Đang đóng các kết nối an toàn...`);
  server.close(() => {
    console.log('[Server] Đã đóng máy chủ HTTP hoàn tất. Tạm biệt!');
    process.exit(0);
  });

  // Force close after 5 seconds timeout
  setTimeout(() => {
    console.error('[Server] Quá thời gian đóng kết nối, buộc dừng tiến trình.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));