import { test } from 'node:test';
import { tx } from './_harness.mjs';
import { cases227 } from './join-request-cases227.mjs';
for(const [name,run] of cases227)test(`227: ${name}`,()=>tx(run));
