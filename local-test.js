require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

async function testGoogleSheetsConnection() {
  console.log('🔧 开始测试 Google Sheets 连接...');

  const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    SPREADSHEET_ID
  } = process.env;

  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !SPREADSHEET_ID) {
    console.error('❌ 缺少必要的环境变量');
    return;
  }

  console.log('✅ 环境变量检查通过');
  console.log('📋 表格ID:', SPREADSHEET_ID);

  try {
    // ✅ 关键：创建 JWT Auth Client
    const authClient = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, authClient);

    await doc.loadInfo();

    console.log('✅ Google Sheets 连接成功!');
    console.log('📊 表格标题:', doc.title);

    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    console.log(`📈 共读取到 ${rows.length} 行数据`);
    console.log('📋 示例:', rows.slice(0, 3).map(r => ({
      ID: r.ID,
      产品名称: r.产品名称,
      价格: r.价格
    })));

  } catch (error) {
    console.error('❌ 连接测试失败:', error.message);
    console.error(error);
  }
}

testGoogleSheetsConnection();
