const { createApp } = require('./src/app');

const app = createApp();
const PORT = parseInt(process.env.PORT || '5000', 10);
app.listen(PORT, () => console.log(`Sahayak ERP listening on http://localhost:${PORT}`));
