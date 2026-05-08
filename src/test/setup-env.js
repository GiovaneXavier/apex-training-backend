// Carregado via --import antes de qualquer outro módulo.
// Garante secrets estáveis para os testes sem depender do .env real.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-32-chars-minimum-12345678';
process.env.AWS_REGION = 'sa-east-1';
process.env.S3_BUCKET = 'apex-test-bucket';
process.env.CORS_ORIGIN = '*';
