// context.js
// Contextual enrichment task for site2rag
// This module will process documents with content_status='raw' and add disambiguating context using AI.
// It uses a centralized callAI(prompt, schema, aiConfig) function for all AI calls.
// Zod is used for schema validation.

import { getDB } from './db.js';
// All DB access must use getDB() from src/db.js. Never instantiate CrawlDB directly.
import { z } from 'zod';
import { callAI } from './call_ai.js';
import fs from 'fs';

// Zod schema for document analysis
export const DocumentAnalysisSchema = z.object({
  bibliographic: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    publisher: z.string().optional(),
    publication_date: z.string().optional(),
    short_description: z.string().optional(),
    long_description: z.string().optional(),
    document_type: z.string().optional(),
    language: z.string().optional(),
    reading_level: z.string().optional(),
    word_count: z.number().optional()
  }),
  content_analysis: z.object({
    subjects: z.array(z.string()).optional(),
    geographical_scope: z.string().optional(),
    time_period: z.string().optional(),
    narrative_perspective: z.string().optional(),
    people: z.array(z.object({ name: z.string(), role: z.string().optional() })).optional(),
    places: z.array(z.object({ name: z.string(), context: z.string().optional() })).optional(),
    organizations: z.array(z.object({ name: z.string(), context: z.string().optional() })).optional(),
    themes: z.array(z.string()).optional()
  }),
  context_summary: z.string()
});

export const ContextedDocSchema = z.object({
  contexted_markdown: z.string(),
  context_summary: z.string().optional(),
});

// Analyze the document to extract metadata, entities, and summary using AI
export async function analyzeDocument(blocks, metadata, aiConfig, callAIImpl = callAI) {
  // Accumulate blocks by word count up to 3000 words
  let wordBudget = 3000, used = 0, selected = [];
  for (const block of blocks) {
    const words = block.text.split(/\s+/).length;
    if (used + words > wordBudget) break;
    selected.push(block.text);
    used += words;
  }
  const docInput = selected.join('\n\n');
  const prompt = `Analyze the following document content and metadata. Extract bibliographic metadata, key people, places, organizations, themes, and write a 2-3 paragraph prose context summary for disambiguation.\n\nMetadata: ${JSON.stringify(metadata)}\n\nContent:\n${docInput}`;
  return await callAIImpl(prompt, DocumentAnalysisSchema, aiConfig);
}

// Build a context window for a block, filling the context budget
export function buildContextWindow(blockIndex, allBlocks, processedBlocks, documentAnalysis, {
  prevBudget = 3000, nextBudget = 1500, entityBudget = 500, totalBudget = 24000
} = {}) {
  const components = {
    documentContext: documentAnalysis.context_summary?.slice(0, 1200) || '',
    currentBlock: allBlocks[blockIndex].text,
    previousBlocks: getPreviousContext(processedBlocks, prevBudget),
    followingBlocks: getFollowingContext(allBlocks, blockIndex, nextBudget),
    keyEntities: getEntityReference(documentAnalysis.content_analysis, entityBudget)
  };
  return optimizeForTokenLimit(components, totalBudget);
}

export function getPreviousContext(processedBlocks, maxChars) {
  let context = '', charCount = 0;
  for (let i = processedBlocks.length - 1; i >= 0; i--) {
    const block = processedBlocks[i].contexted;
    if (charCount + block.length > maxChars) break;
    context = block + '\n\n' + context;
    charCount += block.length + 2;
  }
  return context.trim();
}

export function getFollowingContext(allBlocks, currentIndex, maxChars) {
  let context = '', charCount = 0;
  for (let i = currentIndex + 1; i < allBlocks.length; i++) {
    const block = allBlocks[i].text;
    if (charCount + block.length > maxChars) {
      if (i === currentIndex + 1) {
        context += block.substring(0, maxChars - charCount) + '...';
      }
      break;
    }
    context += block + '\n\n';
    charCount += block.length + 2;
  }
  return context.trim();
}

export function getEntityReference(contentAnalysis, maxChars) {
  const entities = [];
  if (contentAnalysis.people) entities.push('People: ' + contentAnalysis.people.map(p => p.name + (p.role ? ` (${p.role})` : '')).join(', '));
  if (contentAnalysis.places) entities.push('Places: ' + contentAnalysis.places.map(p => p.name).join(', '));
  if (contentAnalysis.organizations) entities.push('Organizations: ' + contentAnalysis.organizations.map(o => o.name).join(', '));
  if (contentAnalysis.themes) entities.push('Themes: ' + contentAnalysis.themes.join(', '));
  let out = entities.join(' | ');
  return out.length > maxChars ? out.slice(0, maxChars) + '...' : out;
}

export function optimizeForTokenLimit(components, tokenLimit) {
  // Strict char-based enforcement, including headers and joiners
  const joiner = '\n\n---\n\n';
  let out = '', parts = [];
  for (const [k, v] of Object.entries(components)) {
    if (v && v.length) parts.push(`## ${k}\n${v}`);
  }
  // Add parts one by one until budget is hit
  let acc = '', i = 0;
  while (i < parts.length) {
    let next = acc ? acc + joiner + parts[i] : parts[i];
    if (next.length > tokenLimit) {
      // Truncate the last part to fit
      let allowed = tokenLimit - (acc ? acc.length + joiner.length : 0);
      if (allowed > 0) acc += (acc ? joiner : '') + parts[i].slice(0, allowed) + '...';
      break;
    } else {
      acc = next;
    }
    i++;
  }
  return acc;
}

/**
 * Run context enrichment for all raw docs in DB.
 * @param {string} dbPath - Path to crawl DB
 * @param {object} aiConfig - AI config (provider, host, model, etc)
 */
export async function runContextEnrichment(dbOrPath, aiConfig) {

  // Helper to strip context summary/notes from enriched text
  function stripContext(text) {
    // Remove context, then compress all whitespace (including newlines)
    return text.replace(/^> CONTEXT SUMMARY[\s\S]*?\n\n/, '')
                .replace(/^> CONTEXT NOTE[\s\S]*?\n\n/, '')
                .replace(/^> .+\n/gm, '')
                .replace(/\s+/g, ' ')
                .trim();
  }
  // Accept either a db instance (CrawlDB) or a path
  let db, shouldClose = false;
  if (typeof dbOrPath === 'string') {
    db = getDB(dbOrPath);
    shouldClose = true;
  } else {
    db = dbOrPath;
  }
  const rawDocs = db.db.prepare("SELECT url, file_path, title FROM pages WHERE content_status = 'raw'").all();
  // Import fs at the top to avoid dynamic import issues with Vite
  // const fs = await import('fs');
  for (const doc of rawDocs) {
    const markdown = doc.file_path ? fs.promises.readFile(doc.file_path, 'utf8') : '';
    // Parse markdown into blocks (simple split, or use a markdown parser for more accuracy)
    const blocks = markdown.split(/\n{2,}/).map(text => ({ text }));
    // Use metadata from DB if present, else empty
    let meta = {};
    try { if (doc.metadata) meta = JSON.parse(doc.metadata); } catch {}
    // Analyze document (AI-powered, budget-filling)
    const analysis = await analyzeDocument(blocks, meta, aiConfig);
    // For each block, build a context window and enrich (could batch, but here per block)
    let processedBlocks = [];

    //   }
    // }
    // Reassemble enriched markdown
    const contextedMarkdown = processedBlocks.map(b => b.contexted).join('\n\n');
    // Optionally prepend context summary
    const finalMarkdown = analysis.context_summary ? `> CONTEXT SUMMARY\n> ${analysis.context_summary}\n\n` + contextedMarkdown : contextedMarkdown;
    await fs.promises.writeFile(doc.file_path, finalMarkdown, 'utf8');
    db.db.prepare('UPDATE pages SET content_status = "contexted" WHERE url = ?').run(doc.url);
  // } catch (err) {
  //   logger.error(`[runContextEnrichment] Failed processing doc with url=${doc.url}:`, err);
  }
  if (shouldClose) db.close();
}
