const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.effortiq');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const configService = {
  async ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  },

  async saveConfig(config) {
    try {
      await this.ensureConfigDir();
      console.log('[configService] Saving configuration to:', CONFIG_FILE);
      
      // Encrypt sensitive data (basic encoding, not secure for production)
      const configToSave = {
        ...config,
        openai: config.openai ? {
          ...config.openai,
          apiKey: Buffer.from(config.openai.apiKey || '').toString('base64')
        } : undefined,
        azure: config.azure ? {
          ...config.azure,
          apiKey: Buffer.from(config.azure.apiKey || '').toString('base64')
        } : undefined,
        gemini: config.gemini ? {
          ...config.gemini,
          apiKey: Buffer.from(config.gemini.apiKey || '').toString('base64')
        } : undefined,
        jira: config.jira ? {
          ...config.jira,
          token: Buffer.from(config.jira.token || '').toString('base64')
        } : undefined
      };

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
      console.log('[configService] Configuration saved successfully');
      return { ok: true };
    } catch (error) {
      console.error('[configService] Failed to save configuration:', error);
      throw new Error(`Failed to save configuration: ${error.message}`);
    }
  },

  async loadConfig() {
    try {
      console.log('[configService] Loading configuration from:', CONFIG_FILE);
      
      if (!fs.existsSync(CONFIG_FILE)) {
        console.log('[configService] Configuration file does not exist yet');
        return { ok: true, data: {} };
      }

      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);
      console.log('[configService] Configuration file found and parsed');

      // Decrypt sensitive data
      if (config.openai?.apiKey) {
        config.openai.apiKey = Buffer.from(config.openai.apiKey, 'base64').toString('utf-8');
      }
      if (config.azure?.apiKey) {
        config.azure.apiKey = Buffer.from(config.azure.apiKey, 'base64').toString('utf-8');
      }
      if (config.gemini?.apiKey) {
        config.gemini.apiKey = Buffer.from(config.gemini.apiKey, 'base64').toString('utf-8');
      }
      if (config.jira?.token) {
        config.jira.token = Buffer.from(config.jira.token, 'base64').toString('utf-8');
      }

      console.log('[configService] Configuration decrypted and loaded successfully');
      return { ok: true, data: config };
    } catch (error) {
      console.error('[configService] Failed to load config:', error);
      return { ok: true, data: {} };
    }
  }
};

module.exports = { configService };
