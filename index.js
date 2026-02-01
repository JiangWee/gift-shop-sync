// index.js - 数据同步服务
const { JWT } = require('google-auth-library');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { Pool } = require('pg');
const cron = require('node-cron');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// 配置信息（从环境变量读取）
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Railway 自动提供数据库连接字符串
const DATABASE_URL = process.env.DATABASE_URL;
const dbPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

console.log('🔧 同步服务启动中...');
console.log('📊 数据库连接:', DATABASE_URL ? '已配置' : '未配置');
console.log('📋 表格ID:', SPREADSHEET_ID || '未配置');

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'gift-shop-sync',
    timestamp: new Date().toISOString()
  });
});

// 手动触发同步的端点
app.get('/sync', async (req, res) => {
  try {
    await syncData();
    res.json({ success: true, message: '手动同步完成' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 主同步函数
async function syncData() {
  console.log('🔄 开始同步数据...', new Date().toLocaleString());

  if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    throw new Error('缺少必要的环境变量配置');
  }

  const authClient = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, authClient);

  try {
    
    await doc.loadInfo();
    console.log('✅ Google Sheets 连接成功:', doc.title);
    // 假设您的产品数据在第一个工作表
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    console.log(`📄 从表格读取到 ${rows.length} 行数据`);

    const products = rows
      .map((row, index) => {
        // 调试：打印前几行
        if (index < 3) {
          console.log(`示例行数据 ${index + 1}:`, {
            id: row.id,
            category: row.category,
            name: row.name,
          });
        }

        return {
          id: Number(row.id),
          category: row.category || null,
          name: row.name?.trim(),
          price: Number(row.price),
          image_url: row.image_url || null,
          stock: Number(row.stock) || 0,
          status: row.status || 'active',
          display_desc: row.display_desc || null,
          detail_desc: row.detail_desc || null,
          product_desc: row.product_desc || null,
          specs: row.specs || null,
          shipping_info: row.shipping_info || null,
        };
      })
      // 过滤无效行
      .filter(p => p.id && p.name && !Number.isNaN(p.price));

    console.log(`✅ 处理完成 ${products.length} 个有效产品`);

    // 更新到数据库
    const client = await dbPool.connect();
    
    try {
      await client.query('BEGIN');

      // 检查 products 表是否存在，如果不存在则创建
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(100),
          image_url VARCHAR(500),
          description TEXT,
          stock INTEGER DEFAULT 0,
          status VARCHAR(50) DEFAULT '上架',
          specs TEXT,
          shipping_info TEXT,
          产品描述 TEXT,
          产品规格 TEXT,
          礼品详情描述 TEXT,
          展示页描述 TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 清空现有产品表
      await client.query('TRUNCATE TABLE products RESTART IDENTITY CASCADE;');

      // 插入新数据
      for (const product of products) {
        const query = `
          INSERT INTO products (
            id, name, price, category, image_url, description, 
            stock, status, specs, shipping_info, 产品描述, 产品规格, 礼品详情描述, 展示页描述
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `;
        await client.query(query, [
          product.id, product.name, product.price, product.category,
          product.image_url, product.description, product.stock,
          product.status, product.specs, product.shipping_info,
          product.产品描述, product.产品规格, product.礼品详情描述, product.展示页描述
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ 数据同步成功！共同步 ${products.length} 个产品到数据库。`);
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ 数据库操作失败:', err);
      throw err;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('❌ 数据同步失败:', error);
    throw error;
  }
}

// 每5分钟同步一次（可以通过环境变量控制）
const SYNC_INTERVAL = process.env.SYNC_INTERVAL || '*/5 * * * *';
cron.schedule(SYNC_INTERVAL, syncData);

// 服务启动后立即同步一次
setTimeout(() => {
  syncData().catch(error => {
    console.error('❌ 初始同步失败:', error);
  });
}, 5000); // 延迟5秒启动，确保服务完全启动

// 启动Express服务
app.listen(PORT, () => {
  console.log(`🚀 同步服务运行在端口 ${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/health`);
  console.log(`🔄 手动同步: http://localhost:${PORT}/sync`);
  console.log(`⏰ 同步间隔: ${SYNC_INTERVAL}`);
});

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('🛑 收到关闭信号，正在清理资源...');
  await dbPool.end();
  process.exit(0);
});