// Jest 29 cannot require postgres.js's ESM source, even on Node versions that
// support require(ESM). Keep this compatibility transform confined to tests.
const ts = require("typescript");
const { pathToFileURL } = require("node:url");

module.exports = {
    process(source, filename) {
        return {
            code: ts.transpileModule(source, {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2020,
                    esModuleInterop: true,
                },
                transformers: {
                    before: [context => {
                        const visit = node => {
                            if (ts.isPropertyAccessExpression(node) && node.name.text === "url" &&
                                ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
                                return ts.factory.createStringLiteral(pathToFileURL(filename).href);
                            }
                            return ts.visitEachChild(node, visit, context);
                        };
                        return root => ts.visitNode(root, visit);
                    }],
                },
            }).outputText,
        };
    },
};
