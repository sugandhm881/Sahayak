function generateOtp() {
  let s = '';
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
  return s;
}
module.exports = { generateOtp };
