const exe = require("@angablue/exe");
const package = require("./package.json");

const build = exe({
    entry: "./index.js",
    out: "./dist/filekeeper.exe",
    skipBundle: false,
    version: "1.0.0",
    // icon: "./logo.ico",
    executionLevel: "asInvoker",
    properties: {
        FileDescription: "FileKeeper",
        ProductName: "FileKeeper",
        LegalCopyright: "EchoSystem https://echosystem.ru",
        OriginalFilename: "filekeeper.exe",
    },
});

build.then(() => console.log("Build completed!"));