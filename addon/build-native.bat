@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

set NODE_DIR=C:\Users\benja\AppData\Local\node-gyp\Cache\37.10.3\include\node
set NAPI_DIR=..\node_modules\node-addon-api
set OUTDIR=build\Release

if not exist "%OUTDIR%" mkdir "%OUTDIR%"

cl /nologo /Ox /MD /EHsc /std:c++17 ^
    /I "%NODE_DIR%" /I "%NAPI_DIR%" ^
    /I "C:\Users\benja\AppData\Local\node-gyp\Cache\37.10.3\include\node" ^
    /D NAPI_CPP_EXCEPTIONS=1 ^
    /D _WINDOWS /D _USRDLL /D NODE_GYP_MODULE_NAME=pair-capture ^
    /Fo"%OUTDIR%\pair-capture.obj" ^
    /c pair-capture.cc

link /nologo /DLL /OUT:"%OUTDIR%\pair-capture.node" ^
    "%OUTDIR%\pair-capture.obj" ^
    "C:\Users\benja\AppData\Local\node-gyp\Cache\37.10.3\x64\node.lib" ^
    ole32.lib oleaut32.lib ^
    /NODEFAULTLIB:MSVCRTD ^
    /IMPLIB:"%OUTDIR%\pair-capture.lib"

echo Build complete: %OUTDIR%\pair-capture.node
