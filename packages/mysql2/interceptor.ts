import { Module } from 'module';
import * as mysql2 from './proxy';

export function interceptModule(){
    const moduleCache = require.cache[require.resolve('mysql2/promise')]
    if (moduleCache) {
        moduleCache.exports = mysql2;
    }

    const originalRequire = Module.prototype.require;
    const newRequire = function (moduleName: string) {
            if (moduleName === 'mysql2/promise') {
                console.log(`Intercepted require for module: ${moduleName}`);
                return mysql2;
            }
            // @ts-ignore
            return originalRequire.call(this, moduleName);
    }

    Object.assign(Module.prototype, { require: newRequire });
}

interceptModule()