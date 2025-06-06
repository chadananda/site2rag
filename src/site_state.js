import fs from 'fs';
import path from 'path';
import { CrawlDB } from './db.js';

export class SiteState {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.stateDir = path.join(outputDir, '.site2rag');
    this.dbPath = path.join(this.stateDir, 'crawl.db');
    this.dbNewPath = path.join(this.stateDir, 'crawl_new.db');
    this.dbPrevPath = path.join(this.stateDir, 'crawl_prev.db');
    this.configPath = path.join(this.stateDir, 'config.json');
    this.ensureAll();
    // Always write to crawl_new.db; if crawl.db exists, copy as starting point
    if (fs.existsSync(this.dbPath)) {
      fs.copyFileSync(this.dbPath, this.dbNewPath);
    }
    this.db = new CrawlDB(this.dbNewPath);
    this.config = this.loadConfig();
  }

  ensureAll() {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    if (!fs.existsSync(this.stateDir)) fs.mkdirSync(this.stateDir);
    if (!fs.existsSync(this.dbPath)) fs.writeFileSync(this.dbPath, '');
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify({ directives: {} }, null, 2));
    }
  }

  loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return { directives: {} };
    }
  }



  close(success = false) {
    this.db.close();
    if (success) {
      // On success: crawl.db → crawl_prev.db, crawl_new.db → crawl.db
      if (fs.existsSync(this.dbPath)) {
        if (fs.existsSync(this.dbPrevPath)) {
          fs.unlinkSync(this.dbPrevPath);
        }
        fs.renameSync(this.dbPath, this.dbPrevPath);
      }
      fs.renameSync(this.dbNewPath, this.dbPath);
    } else {
      // On failure, remove crawl_new.db
      if (fs.existsSync(this.dbNewPath)) {
        fs.unlinkSync(this.dbNewPath);
      }
    }
  }
}
