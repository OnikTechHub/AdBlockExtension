import { build } from 'esbuild';
import { execSync } from 'child_process';

console.log('⚡ Building Chrome Blocks (TypeScript + Tailwind CSS)...');

try {
  // 1. Compile Tailwind CSS
  console.log('📦 Compiling Tailwind CSS for Popup...');
  execSync('npx @tailwindcss/cli -i src/popup.css -o popup.css --minify', { stdio: 'inherit' });

  // 2. Bundle TypeScript Scripts
  console.log('🛠️ Bundling TypeScript source files with esbuild...');
  await build({
    entryPoints: {
      background: 'src/background.ts',
      content: 'src/content.ts',
      popup: 'src/popup.ts'
    },
    bundle: true,
    outdir: '.',
    format: 'iife',
    target: ['chrome100'],
    minify: false,
    sourcemap: false
  });

  // 3. Type Checking
  console.log('🔍 Running strict TypeScript validation...');
  execSync('npx tsc --noEmit', { stdio: 'inherit' });

  console.log('✅ Build completed successfully with 100% type safety!');
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}

