const QRCode = require('qrcode');

async function generateUpiQrBase64(upiId, upiName, amount) {
  try {
    const amt = Number(amount || 0).toFixed(2);
    const upiStr = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(upiName)}&am=${amt}&cu=INR`;
    const dataUrl = await QRCode.toDataURL(upiStr, { margin: 2, scale: 4 });
    return dataUrl.split(',')[1];
  } catch (e) { return null; }
}

async function generateUpiQrBuffer(upiId, upiName, amount) {
  try {
    const amt = Number(amount || 0).toFixed(2);
    const upiStr = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(upiName)}&am=${amt}&cu=INR`;
    return await QRCode.toBuffer(upiStr, { margin: 2, scale: 4 });
  } catch (e) { return null; }
}

module.exports = { generateUpiQrBase64, generateUpiQrBuffer };
