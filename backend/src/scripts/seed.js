import { runMigrations } from '../db.js';
import { seed } from '../seed.js';

runMigrations();
const summary = seed();
console.log('Seed completado:', JSON.stringify(summary));