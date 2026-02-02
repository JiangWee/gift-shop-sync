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

// google sheets 表头信息
// 0  ID
// 1  分类
// 2  产品名称
// 3  价格
// 4  图片URL
// 5  库存
// 6  状态
// 7  展示页描述
// 8  礼品详情描述
// 9  产品描述
// 10 产品规格
// 11 配送信息

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
    // ===== 1. 读取 Google Sheet =====
    await doc.loadInfo();
    console.log('✅ Google Sheets 连接成功:', doc.title);

    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    console.log(`📄 从表格读取到 ${rows.length} 行数据`);

    const products = rows
      .map(row => {
        const raw = row._rawData;

        return {
          id: Number(raw[0]),
          category: raw[1] || null,
          name: raw[2] || null,
          price: Number(String(raw[3] || '').replace(/,/g, '')),
          image_url: raw[4] || null,
          stock: Number(raw[5]) || 0,
          status: raw[6] || null,

          display_desc: raw[7] || null,
          gift_detail_desc: raw[8] || null,
          product_desc: raw[9] || null,
          product_specs: raw[10] || null,
          shipping_info: raw[11] || null,
        };
      })
      .filter(p => p.id && p.name);

    console.log(`✅ 处理完成 ${products.length} 个有效产品`);

    if (products.length === 0) {
      console.warn('⚠️ 无有效产品，跳过数据库同步');
      return;
    }

    // ===== 2. 写入数据库 =====
    const client = await dbPool.connect();

    try {
      await client.query('BEGIN');

      // 建表（结构与 JS 完全一致）
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT,
          price NUMERIC(10,2),
          image_url TEXT,
          stock INTEGER,
          status TEXT,

          display_desc TEXT,
          gift_detail_desc TEXT,
          product_desc TEXT,
          product_specs TEXT,
          shipping_info TEXT,

          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 清空表
      await client.query('TRUNCATE TABLE products;');

      // 插入数据
      const insertSQL = `
        INSERT INTO products (
          id,
          name,
          category,
          price,
          image_url,
          stock,
          status,
          display_desc,
          gift_detail_desc,
          product_desc,
          product_specs,
          shipping_info
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        )
      `;

      for (const p of products) {
        await client.query(insertSQL, [
          p.id,
          p.name,
          p.category,
          p.price,
          p.image_url,
          p.stock,
          p.status,
          p.display_desc,
          p.gift_detail_desc,
          p.product_desc,
          p.product_specs,
          p.shipping_info,
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ 数据同步成功！共写入 ${products.length} 条产品数据`);

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