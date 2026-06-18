// =====================================================
// Read Yardi Files — n8n Code Node
// =====================================================
// Purpose: Reads all .xlsx and .csv files from
//          /yardi-input/ and returns structured JSON
// Used as: Sub-workflow tool connected to AI Agent
// =====================================================

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const FOLDER = process.env.YARDI_INPUT_FOLDER || '/home/n8n/yardi-input';

const files = fs.readdirSync(FOLDER, { withFileTypes: true })
  .filter(f => f.isFile() && ['.xlsx','.csv','.xls']
    .includes(path.extname(f.name).toLowerCase()))
  .map(f => f.name);

const result = { _files_loaded: files };

for (const file of files) {
  const wb  = XLSX.readFile(path.join(FOLDER, file));
  const key = file.toLowerCase().includes('actual')       ? 'actuals'
            : file.toLowerCase().includes('budget')       ? 'budget'
            : file.toLowerCase().includes('rent')         ? 'rent_roll'
            : file.toLowerCase().includes('cmhc')         ? 'cmhc_data'
            : file.toLowerCase().includes('market') ||
              file.toLowerCase().includes('report')       ? 'market_report'
            : 'other';

  const data = XLSX.utils.sheet_to_json(
    wb.Sheets[wb.SheetNames[0]], { defval: null }
  );

  if (!result[key]) result[key] = [];
  result[key].push({ file, rows: data.length, data });
}

return [{ json: result }];
