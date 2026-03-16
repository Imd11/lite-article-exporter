#!/usr/bin/env node

import { createWriteStream, promises as fs } from 'fs';
import archiver from 'archiver';
import path from 'path';

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, 'dist');
const packageDir = path.join(projectRoot, 'packages');
const target = process.argv[2] === 'edge' ? 'edge' : 'chrome';

async function getPackageName() {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const suffix = target === 'edge' ? '-edge' : '';
  return `lite-article-exporter-${packageJson.version}${suffix}.zip`;
}

async function createPackage() {
  try {
    const packageName = await getPackageName();

    // 确保 packages 目录存在
    await fs.mkdir(packageDir, { recursive: true });
    
    // 创建 zip 文件
    const output = createWriteStream(path.join(packageDir, packageName));
    const archive = archiver('zip', {
      zlib: { level: 9 } // 最高压缩级别
    });
    
    console.log('📦 开始打包扩展...');
    
    // 监听事件
    output.on('close', () => {
      console.log(`✅ 打包完成！`);
      console.log(`📁 文件位置: packages/${packageName}`);
      console.log(`📊 文件大小: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
      console.log(`\n🚀 现在可以分享给同事了！`);
    });
    
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('⚠️ ', err);
      } else {
        throw err;
      }
    });
    
    archive.on('error', (err) => {
      throw err;
    });
    
    // 连接输出流
    archive.pipe(output);
    
    // 添加 dist 目录下的所有文件
    archive.directory(distDir, false);
    
    // 完成打包
    await archive.finalize();
    
  } catch (error) {
    console.error('❌ 打包失败:', error);
    process.exit(1);
  }
}

createPackage();
