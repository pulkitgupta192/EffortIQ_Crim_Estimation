const XLSX = require('xlsx');
const fs = require('fs');

const excelService = {
  async parseExcel(filePath) {
    try {
      // Read file as binary
      const fileBuffer = fs.readFileSync(filePath);
      
      // Parse workbook
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      
      // Get all rows
      const rows = XLSX.utils.sheet_to_json(worksheet);
      
      // Normalize column names and filter valid rows
      const normalized = rows
        .filter(row => row && Object.keys(row).length > 0)
        .map(row => ({
          summary: row.Summary || row.summary || row.SUMMARY || '',
          description: row.Description || row.description || row.DESCRIPTION || '',
          crim_type: row['CRIM Type'] || row['Crim Type'] || row['crim_type'] || row['CRIM_TYPE'] || ''
        }))
        .filter(row => row.summary || row.description);
      
      return normalized;
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
  }
};

module.exports = { excelService };
