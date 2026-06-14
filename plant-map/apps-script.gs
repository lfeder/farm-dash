// Google Apps Script — paste into your Apps Script project at script.google.com
//
// After updating: Deploy > Manage deployments > Edit (pencil icon) > Version: New version > Deploy

function doPost(e) {
  var data;
  if (e.parameter && e.parameter.payload) {
    data = JSON.parse(e.parameter.payload);
  } else {
    data = JSON.parse(e.postData.contents);
  }

  var ss = SpreadsheetApp.openById('1ewWyvaXGkRCvZxjUxBOHGY4PKdMHwKeTA5jTIod48LE');
  var sheet = ss.getSheets().filter(function(s) { return s.getSheetId() == 1615707612; })[0];

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  data.edits.forEach(function(edit) {
    sheet.getRange(edit.row, 11).setValue(edit.value);
    if (edit.ppb) sheet.getRange(edit.row, 10).setValue(edit.ppb);
  });

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
