import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';

// Pure JS base64 encoder — works in all RN / Hermes environments where
// global atob/btoa may not exist or may choke on binary data.
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ArrayToBase64(uint8) {
  let result = '';
  const len = uint8.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = uint8[i];
    const b1 = i + 1 < len ? uint8[i + 1] : 0;
    const b2 = i + 2 < len ? uint8[i + 2] : 0;

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += (i + 1 < len) ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += (i + 2 < len) ? BASE64_CHARS[b2 & 63] : '=';
  }
  return result;
}

/**
 * Write the workbook to the device cache and hand off to the native share
 * sheet so the user can save it to Drive / mail / Files.
 */
export async function saveAndShareExcel(workbook, filename) {
  const wbout = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const bytes = new Uint8Array(wbout);
  const base64String = uint8ArrayToBase64(bytes);

  const filePath = `${FileSystem.cacheDirectory}${filename}`;

  await FileSystem.writeAsStringAsync(filePath, base64String, {
    encoding: 'base64',
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(filePath, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: `Share ${filename}`,
      UTI: 'com.microsoft.excel.xlsx',
    });
  }

  return filePath;
}
