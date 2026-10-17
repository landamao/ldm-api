// Package web 承载全部前端静态资源，编译期嵌入二进制，实现单文件分发。
package web

import "embed"

//go:embed all:assets
//go:embed index.html
var FS embed.FS
