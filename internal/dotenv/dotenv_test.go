package dotenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	input := "\ufeff# 注释\n" +
		"\n" +
		"  export FOO=bar  \n" +
		"PATH_WITH_EQUALS=a=b=c\n" +
		"EMPTY=\n" +
		"SINGLE='a # b'\n" +
		"DOUBLE=\"line\\nnext\\t\\\"q\\\" \\\\ \\d\"\n" +
		"WIN=C:\\data\\ldmapi\n" +
		"HASH=abc#def\n" +
		"COMMENTED=value # 行尾注释\n" +
		"QUOTED_COMMENT=\"x\" # 注释\n" +
		"  # 缩进注释\n"

	pairs, err := Parse(strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := []Pair{
		{"FOO", "bar"},
		{"PATH_WITH_EQUALS", "a=b=c"},
		{"EMPTY", ""},
		{"SINGLE", "a # b"},
		{"DOUBLE", "line\nnext\t\"q\" \\ \\d"},
		{"WIN", `C:\data\ldmapi`},
		{"HASH", "abc#def"},
		{"COMMENTED", "value"},
		{"QUOTED_COMMENT", "x"},
	}
	if len(pairs) != len(want) {
		t.Fatalf("得到 %d 条键值对，期望 %d 条：%v", len(pairs), len(want), pairs)
	}
	for i, w := range want {
		if pairs[i] != w {
			t.Errorf("第 %d 条为 %q=%q，期望 %q=%q", i, pairs[i].Key, pairs[i].Value, w.Key, w.Value)
		}
	}
}

func TestParseCRLF(t *testing.T) {
	pairs, err := Parse(strings.NewReader("A=1\r\nB=2\r\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(pairs) != 2 || pairs[0].Value != "1" || pairs[1].Value != "2" {
		t.Fatalf("CRLF 解析结果不对：%v", pairs)
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"缺少等号", "FOO\n", "缺少 ="},
		{"变量名非法", "1FOO=bar\n", "无效的变量名"},
		{"变量名为空", "=bar\n", "无效的变量名"},
		{"单引号未闭合", "FOO='bar\n", "单引号没有闭合"},
		{"双引号未闭合", "FOO=\"bar\n", "双引号没有闭合"},
		{"引号后多余内容", "FOO=\"bar\" baz\n", "多余内容"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Parse(strings.NewReader(c.input))
			if err == nil {
				t.Fatalf("期望报错，实际解析成功")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误信息 %q 不包含 %q", err.Error(), c.want)
			}
			if !strings.Contains(err.Error(), "第 1 行") {
				t.Fatalf("错误信息 %q 没有行号", err.Error())
			}
		})
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.env")
	second := filepath.Join(dir, "second.env")
	missing := filepath.Join(dir, "missing.env")

	if err := os.WriteFile(first, []byte("DOTENV_TEST_NEW=from-first\nDOTENV_TEST_KEEP=from-first\nDOTENV_TEST_DUP=first\nDOTENV_TEST_DUP=second\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("DOTENV_TEST_NEW=from-second\nDOTENV_TEST_SECOND=only-second\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("DOTENV_TEST_KEEP", "from-env")
	t.Cleanup(func() {
		os.Unsetenv("DOTENV_TEST_NEW")
		os.Unsetenv("DOTENV_TEST_SECOND")
		os.Unsetenv("DOTENV_TEST_DUP")
	})

	loaded, err := Load(first, missing, second)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != 2 || loaded[0] != first || loaded[1] != second {
		t.Fatalf("实际加载的文件为 %v，期望 [%s %s]", loaded, first, second)
	}
	if got := os.Getenv("DOTENV_TEST_NEW"); got != "from-first" {
		t.Errorf("DOTENV_TEST_NEW = %q，期望 from-first（先加载的文件优先）", got)
	}
	if got := os.Getenv("DOTENV_TEST_KEEP"); got != "from-env" {
		t.Errorf("DOTENV_TEST_KEEP = %q，期望 from-env（不覆盖已有环境变量）", got)
	}
	if got := os.Getenv("DOTENV_TEST_SECOND"); got != "only-second" {
		t.Errorf("DOTENV_TEST_SECOND = %q，期望 only-second", got)
	}
	if got := os.Getenv("DOTENV_TEST_DUP"); got != "second" {
		t.Errorf("DOTENV_TEST_DUP = %q，期望 second（同一个文件里以最后一次为准）", got)
	}
}

func TestLoadInvalidFileReportsPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.env")
	if err := os.WriteFile(path, []byte("NOT_A_PAIR\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("期望报错，实际加载成功")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("错误信息 %q 没有包含文件路径", err.Error())
	}
}
