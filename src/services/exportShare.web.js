import * as XLSX from 'xlsx';

/**
 * Write the workbook into a Blob and trigger a browser download. Works in
 * Chrome / Safari / Firefox / Edge with no extra dependencies.
 */
export async function saveAndShareExcel(workbook, filename) {
  const wbout = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const bytes = new Uint8Array(wbout);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Give the browser a moment to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return filename;
}
