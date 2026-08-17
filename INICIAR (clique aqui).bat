@echo off
title Leco Shop - Painel de Vendas
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js nao encontrado.
  echo  Baixe a versao LTS em https://nodejs.org , instale e rode este atalho de novo.
  echo.
  pause
  exit /b
)

echo.
echo  Iniciando o painel da Leco Shop...
echo  Abra no navegador: http://localhost:3000
echo  (Para fechar o painel, feche esta janela preta.)
echo.
start "" http://localhost:3000
node server.js
pause
