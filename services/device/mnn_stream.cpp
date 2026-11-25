// mnn_stream.cpp —— 长驻推理进程
//
// 设计：stdin 收请求、stdout 逐 token 吐文本，避免任何跨线程共享 MNN 内部状态。
//
// 请求协议（stdin）：
//   REQ\n
//   MAX 256\n
//   MSG <role> <len>\n<len 字节正文>\n
//   MSG ...\n
//   END\n
//
// 响应协议（stdout，每行一个 JSON）：
//   {"t":"ready"}
//   {"t":"d","x":"<token>"}   ← 每个 token 一行
//   {"t":"e"}
//   {"t":"err","x":"..."}
//
// 用法：mnn_stream.exe <config.json>

#include <llm/llm.hpp>

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <streambuf>
#include <string>
#include <vector>

using namespace MNN::Transformer;

static std::string jsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    o += buf;
                } else {
                    o += static_cast<char>(c);   // UTF-8 直接透传
                }
        }
    }
    return o;
}

// 返回 s 中「完整 UTF-8 序列」的字节数；末尾不完整的序列留到下一次拼接
static size_t utf8CompleteLen(const std::string& s) {
    size_t i = s.size();
    size_t start = i;
    while (start > 0 && (static_cast<unsigned char>(s[start - 1]) & 0xC0) == 0x80) {
        --start;                       // 跳过续字节
    }
    if (start == 0) {
        return s.size();               // 全是续字节，交给调用方拼接
    }
    unsigned char c = static_cast<unsigned char>(s[start - 1]);
    size_t need = 1;
    if ((c & 0x80) == 0x00)      need = 1;
    else if ((c & 0xE0) == 0xC0) need = 2;
    else if ((c & 0xF0) == 0xE0) need = 3;
    else if ((c & 0xF8) == 0xF0) need = 4;
    else                         need = 1;   // 非法起始字节，不阻塞
    size_t have = i - (start - 1);
    return (have >= need) ? s.size() : (start - 1);
}

// 把 MNN 写进来的 token 变成一行 JSON
class TokenBuf : public std::streambuf {
public:
    explicit TokenBuf(std::ostream& out) : mOut(out) {}

protected:
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        if (n > 0) {
            mPending.append(s, static_cast<size_t>(n));
            size_t complete = utf8CompleteLen(mPending);
            if (complete > 0) {
                emit(mPending.substr(0, complete));
                mPending.erase(0, complete);
            }
        }
        return n;
    }
    int overflow(int c) override {
        if (c != EOF) {
            char ch = static_cast<char>(c);
            xsputn(&ch, 1);
        }
        return c;
    }

private:
    void emit(const std::string& t) {
        mOut << "{\"t\":\"d\",\"x\":\"" << jsonEscape(t) << "\"}\n";
        mOut.flush();
    }
    std::ostream& mOut;
    std::string mPending;
};

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: mnn_stream <config.json>\n";
        return 2;
    }

    Llm* llm = Llm::createLLM(argv[1]);
    if (llm == nullptr) {
        std::cerr << "createLLM failed: " << argv[1] << "\n";
        return 3;
    }
    if (!llm->load()) {
        std::cerr << "load failed\n";
        Llm::destroy(llm);
        return 4;
    }
    std::cout << "{\"t\":\"ready\"}\n" << std::flush;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line != "REQ") {
            continue;
        }
        ChatMessages msgs;
        int maxTokens = 256;

        while (std::getline(std::cin, line)) {
            if (line == "END") {
                break;
            }
            if (line.rfind("MAX ", 0) == 0) {
                maxTokens = std::atoi(line.c_str() + 4);
                continue;
            }
            if (line.rfind("MSG ", 0) == 0) {
                std::istringstream is(line.substr(4));
                std::string role;
                size_t len = 0;
                is >> role >> len;
                std::string content(len, '\0');
                if (len > 0) {
                    std::cin.read(&content[0], static_cast<std::streamsize>(len));
                }
                std::cin.get();   // 吃掉正文后面的换行
                msgs.emplace_back(role, std::move(content));
            }
        }

        if (msgs.empty()) {
            std::cout << "{\"t\":\"e\"}\n" << std::flush;
            continue;
        }

        try {
            TokenBuf buf(std::cout);
            std::ostream os(&buf);
            llm->reset();
            llm->response(msgs, &os, nullptr, maxTokens);
        } catch (const std::exception& e) {
            std::cout << "{\"t\":\"err\",\"x\":\"" << jsonEscape(e.what()) << "\"}\n" << std::flush;
        }
        std::cout << "{\"t\":\"e\"}\n" << std::flush;
    }

    Llm::destroy(llm);
    return 0;
}
