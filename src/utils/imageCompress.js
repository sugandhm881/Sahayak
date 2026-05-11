const sharp = require('sharp');

async function compressImage(buffer, maxWidth = 400) {
  try {
    const img = sharp(buffer);
    const meta = await img.metadata();
    let pipeline = img;
    if (meta.width && meta.width > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth });
    }
    const out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return out.toString('base64');
  } catch (e) {
    return null;
  }
}

module.exports = { compressImage };
