import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = process.cwd()

describe('Project Structure', () => {
  it('should have a src/ directory', () => {
    expect(fs.existsSync(path.join(root, 'src'))).toBe(true)
  })

  it('should have a tests/ directory', () => {
    expect(fs.existsSync(path.join(root, 'tests'))).toBe(true)
  })

  it('should have a .gitignore file', () => {
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(true)
  })

  it('should have a package.json file', () => {
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
  })

  it('should have a README.md file', () => {
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true)
  })


  it('should have required dependencies installed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
    const deps = Object.keys(pkg.dependencies || {})
    expect(deps).toEqual(expect.arrayContaining([
      'cheerio', 'turndown', 'better-sqlite3', 'p-limit'
    ]))
  })
})
