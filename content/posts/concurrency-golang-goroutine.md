---
title: "并发模型全景图（三）：Go 的 goroutine 凭什么这么轻"
tags: ["Go", "架构"]
summary: "Go 的并发之所以好用，不只是因为 goroutine 轻量，更因为 Go 运行时实现了一套 M:N 调度器，让协程能真正利用多核。这篇文章拆解 goroutine 的底层原理、GMP 调度模型、channel 的设计哲学，以及 Go 里常见的并发陷阱。"
---

Go 的并发模型是很多人从 Python/Java 转过来之后最大的惊喜：goroutine 极其轻量，随手 `go func()` 启动一个并发任务，不需要管线程池，不需要 async/await，代码看起来像同步但实际是并发的。

这篇文章讲清楚 goroutine 为什么能做到这些，以及用 Go 写并发代码时需要注意什么。

---

## Goroutine 是什么

Goroutine 是 Go 运行时管理的轻量级并发执行单元，不是操作系统线程。

```go
package main

import (
    "fmt"
    "time"
)

func say(s string) {
    for i := 0; i < 3; i++ {
        fmt.Println(s)
        time.Sleep(100 * time.Millisecond)
    }
}

func main() {
    go say("goroutine")  // 启动一个 goroutine
    say("main")          // main 函数本身也是一个 goroutine
}
```

`go say("goroutine")` 就启动了一个并发执行的 goroutine，语法就这么简单。

### Goroutine 有多轻

| 对比项 | 操作系统线程 | Goroutine |
|--------|-------------|-----------|
| 初始栈大小 | 1-8 MB（固定） | 8 KB（动态增长） |
| 栈上限 | 固定 | 1 GB（默认） |
| 创建开销 | ~10μs | ~0.3μs |
| 上下文切换 | ~1μs（内核态） | ~0.1μs（用户态） |
| 实用上限 | 数千个 | 百万个 |

Go 程序里同时运行几十万个 goroutine 是完全正常的。HTTP 服务器每收到一个请求就 `go handle(conn)` 一个 goroutine，不需要线程池。

---

## GMP 调度模型：goroutine 怎么真正利用多核

这是 Go 并发的核心机制。

Python 的协程（asyncio）是单线程的，无法利用多核。Go 的 goroutine 通过 **GMP 调度模型**解决了这个问题。

### G、M、P 分别是什么

```
G（Goroutine）：待执行的 goroutine
M（Machine）：操作系统线程，真正在 CPU 上执行
P（Processor）：逻辑处理器，持有本地任务队列，连接 G 和 M
```

```
全局队列: [G5] [G6] [G7]
              ↑取
P1: [G1][G2] → M1（绑定到 CPU 核心1）
P2: [G3][G4] → M2（绑定到 CPU 核心2）
P3: []        → M3（空闲）
```

`GOMAXPROCS`（默认等于 CPU 核心数）决定了 P 的数量，也就是真正并行执行的 goroutine 数量。

### 调度流程

```go
// 这行代码的背后：
go myFunc()

// 1. 创建 G（goroutine 对象，初始 8KB 栈）
// 2. 优先放入当前 P 的本地队列
// 3. 如果本地队列满了，放入全局队列
// 4. M 从 P 的本地队列取 G 执行
// 5. 本地队列空了，从全局队列或其他 P "偷" G（Work Stealing）
```

**Work Stealing（工作窃取）** 是关键：空闲的 P 会去偷其他 P 的 goroutine 来执行，保证 CPU 不空转。

### 系统调用时会发生什么

当一个 goroutine 执行系统调用（如读文件）阻塞时：

```
正常状态:
G1 → P1 → M1 → CPU

G1 调用 read()（系统调用，可能阻塞）:
G1 → M1（进入内核，被阻塞）
P1 → M2（新线程或空闲线程接管 P1，继续运行 G2, G3...）

G1 的 read() 返回:
G1 → 全局队列（等待被某个 P 调度）
M1 → 空闲线程池（等待被复用）
```

这就是为什么 Go 里写同步风格的代码（直接调 `db.Query()`），但底层实际上是非阻塞的——Go 运行时在系统调用层面做了处理，不会让整个程序卡住。

---

## Channel：Go 并发的通信方式

Go 的并发哲学：

> **"不要通过共享内存来通信，而是通过通信来共享内存。"**

这句话的意思：与其用多个 goroutine 共享一个变量（然后加锁），不如用 channel 在 goroutine 之间传递数据。

### Channel 基础

```go
// 创建 channel
ch := make(chan int)       // 无缓冲 channel
ch := make(chan int, 10)   // 有缓冲 channel，容量 10

// 发送
ch <- 42

// 接收
value := <-ch

// 关闭
close(ch)

// range 遍历（直到 channel 关闭）
for v := range ch {
    fmt.Println(v)
}
```

### 无缓冲 channel：同步通信

无缓冲 channel 的发送和接收必须同时准备好，否则阻塞：

```go
func main() {
    ch := make(chan string)

    go func() {
        time.Sleep(1 * time.Second)
        ch <- "done"  // 发送，等待有人接收
    }()

    msg := <-ch  // 接收，阻塞直到有数据
    fmt.Println(msg)
}
```

这是 goroutine 同步的常用方式：主 goroutine 等待子 goroutine 完成。

### 有缓冲 channel：异步通信

```go
ch := make(chan int, 3)  // 缓冲区容量 3

ch <- 1  // 不阻塞
ch <- 2  // 不阻塞
ch <- 3  // 不阻塞
ch <- 4  // 阻塞！缓冲区满了

fmt.Println(<-ch)  // 读出一个，空出位置
ch <- 4            // 现在可以发送了
```

有缓冲 channel 常用于限流：

```go
// 用缓冲 channel 实现信号量，限制并发数
sem := make(chan struct{}, 10)  // 最多 10 个并发

for _, task := range tasks {
    sem <- struct{}{}  // 占位，满了就等
    go func(t Task) {
        defer func() { <-sem }()  // 完成后释放
        process(t)
    }(task)
}
```

### select：监听多个 channel

`select` 类似 `switch`，但用于 channel 操作：

```go
func main() {
    ch1 := make(chan string)
    ch2 := make(chan string)

    go func() { time.Sleep(1 * time.Second); ch1 <- "one" }()
    go func() { time.Sleep(2 * time.Second); ch2 <- "two" }()

    for i := 0; i < 2; i++ {
        select {
        case msg := <-ch1:
            fmt.Println("收到 ch1:", msg)
        case msg := <-ch2:
            fmt.Println("收到 ch2:", msg)
        }
    }
}
```

`select` 会阻塞直到某个 case 可以执行，多个 case 同时就绪时随机选一个。

**带超时的 select：**

```go
select {
case result := <-ch:
    fmt.Println("得到结果:", result)
case <-time.After(5 * time.Second):
    fmt.Println("超时了")
}
```

**非阻塞 select：**

```go
select {
case msg := <-ch:
    fmt.Println("有数据:", msg)
default:
    fmt.Println("没有数据，不等待")
}
```

---

## Context：优雅取消和超时

`context.Context` 是 Go 并发编程的标配，用于传递取消信号、超时、截止时间和请求范围的值。

### 超时控制

```go
func fetchWithTimeout(url string) ([]byte, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()  // 函数结束时释放资源

    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err  // 超时会返回 context.DeadlineExceeded
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}
```

### 取消传播

```go
func main() {
    ctx, cancel := context.WithCancel(context.Background())

    // 启动多个 goroutine，都监听同一个 ctx
    for i := 0; i < 5; i++ {
        go worker(ctx, i)
    }

    time.Sleep(3 * time.Second)
    cancel()  // 发出取消信号，所有 worker 都会收到
    time.Sleep(1 * time.Second)
}

func worker(ctx context.Context, id int) {
    for {
        select {
        case <-ctx.Done():
            fmt.Printf("worker %d 收到取消信号，退出\n", id)
            return
        default:
            fmt.Printf("worker %d 工作中\n", id)
            time.Sleep(500 * time.Millisecond)
        }
    }
}
```

### 在 HTTP 服务里

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()  // 请求的 context，客户端断开时自动取消

    result, err := db.QueryContext(ctx, "SELECT ...")
    // 如果客户端在查询过程中断开，ctx 会被取消，查询自动中断
    // 不会让数据库做无用功
}
```

---

## sync 包：共享状态的同步原语

虽然 Go 推荐用 channel 通信，但有时候直接共享内存更简单，这时候用 `sync` 包。

### sync.Mutex：互斥锁

```go
type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (c *SafeCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func (c *SafeCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}

// 并发安全
counter := &SafeCounter{}
for i := 0; i < 1000; i++ {
    go counter.Increment()
}
```

### sync.RWMutex：读写锁

读多写少的场景，用读写锁比互斥锁性能更好：

```go
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()    // 读锁：多个 goroutine 可以同时读
    defer c.mu.RUnlock()
    val, ok := c.data[key]
    return val, ok
}

func (c *Cache) Set(key, value string) {
    c.mu.Lock()     // 写锁：独占，写入期间其他 goroutine 不能读也不能写
    defer c.mu.Unlock()
    c.data[key] = value
}
```

### sync.WaitGroup：等待多个 goroutine 完成

```go
func main() {
    var wg sync.WaitGroup
    results := make([]int, 5)

    for i := 0; i < 5; i++ {
        wg.Add(1)  // 计数 +1
        go func(idx int) {
            defer wg.Done()  // 完成后计数 -1
            results[idx] = idx * idx
        }(i)
    }

    wg.Wait()  // 阻塞直到计数为 0
    fmt.Println(results)
}
```

### sync.Once：只执行一次

```go
var (
    instance *Database
    once     sync.Once
)

func GetDB() *Database {
    once.Do(func() {
        instance = &Database{...}  // 只会执行一次，即使多个 goroutine 同时调用
    })
    return instance
}
```

### sync.Map：并发安全的 map

```go
var m sync.Map

// 写
m.Store("key", "value")

// 读
value, ok := m.Load("key")

// 读不到就写入（Load-or-Store）
actual, loaded := m.LoadOrStore("key", "default")

// 遍历
m.Range(func(key, value interface{}) bool {
    fmt.Println(key, value)
    return true  // 返回 false 停止遍历
})
```

---

## errgroup：并发执行 + 错误收集

`golang.org/x/sync/errgroup` 是 `sync.WaitGroup` 的增强版，支持错误传播和 context 取消：

```go
import "golang.org/x/sync/errgroup"

func fetchAll(urls []string) ([][]byte, error) {
    g, ctx := errgroup.WithContext(context.Background())
    results := make([][]byte, len(urls))

    for i, url := range urls {
        i, url := i, url  // 注意：捕获循环变量
        g.Go(func() error {
            data, err := fetchWithContext(ctx, url)
            if err != nil {
                return err  // 一个失败，ctx 会被取消，其他的也会收到取消信号
            }
            results[i] = data
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

---

## Go vs Python 并发：直观对比

```
Python asyncio（单线程协程）：
主线程: [事件循环] → 协程A ─await─ 协程B ─await─ 协程A ...
         ↑一个线程，无法利用多核↑

Go goroutine（M:N 调度）：
线程1(P1): [goroutineA] → [goroutineB] → [goroutineC]
线程2(P2): [goroutineD] → [goroutineE] → [goroutineF]
线程3(P3): [goroutineG] → [goroutineH] → [goroutineI]
         ↑多线程，真正利用多核↑
```

**实际效果：**

```go
// Go：可以直接并发 CPU 密集型任务
var wg sync.WaitGroup
for i := 0; i < runtime.NumCPU(); i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        cpuHeavyWork()  // 真正并行，每个 goroutine 跑在不同核上
    }()
}
wg.Wait()
```

```python
# Python：CPU 密集型只能用多进程
import multiprocessing
with multiprocessing.Pool() as pool:
    pool.map(cpu_heavy_work, range(cpu_count))
# goroutine 语法更简单，还不需要序列化数据
```

---

## 常见并发陷阱

### 1. Goroutine 泄漏

```go
// 危险：goroutine 永久阻塞，无法退出
func leak() {
    ch := make(chan int)
    go func() {
        val := <-ch  // 没人发送，永远阻塞，goroutine 永远不会退出
        fmt.Println(val)
    }()
    // 函数返回，ch 没人关闭，goroutine 泄漏
}

// 正确：用 context 取消
func noLeak(ctx context.Context) {
    ch := make(chan int)
    go func() {
        select {
        case val := <-ch:
            fmt.Println(val)
        case <-ctx.Done():
            return  // context 取消时退出
        }
    }()
}
```

### 2. 循环变量捕获

```go
// 危险：所有 goroutine 共享同一个 i 变量
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i)  // 很可能全部打印 5
    }()
}

// 正确：传参捕获
for i := 0; i < 5; i++ {
    go func(n int) {
        fmt.Println(n)  // 每个 goroutine 有自己的 n
    }(i)
}

// Go 1.22+ 修复了这个问题，循环变量每次迭代是新的
```

### 3. 向已关闭的 channel 发送数据（panic）

```go
ch := make(chan int)
close(ch)
ch <- 1  // panic: send on closed channel

// 原则：只有发送方才应该关闭 channel
// 接收方不关闭 channel
```

### 4. 数据竞争（Data Race）

```go
// 用 -race 标志检测数据竞争
// go run -race main.go
// go test -race ./...

var counter int

func main() {
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter++  // 数据竞争！-race 会检测到
        }()
    }
    wg.Wait()
}
```

**养成习惯：开发时总是加 `-race` 标志运行测试。**

---

## 选择 channel 还是 sync 原语

Go 官方的建议：

- **用 channel**：传递数据所有权、分发工作、通知事件、pipeline 模式
- **用 sync.Mutex**：保护简单的共享状态（计数器、缓存、配置）

```
这个变量需要在多个 goroutine 间传递吗？
    → 是：channel
    → 否，只是多个 goroutine 共享读写这个变量？
        → sync.Mutex / sync.RWMutex
        → 简单的计数器？sync/atomic
```

---

## 三篇总结对比

| | Python asyncio / FastAPI | Go goroutine |
|--|--------------------------|--------------|
| **并发单位** | 协程（coroutine） | goroutine |
| **调度者** | 事件循环（单线程） | Go 运行时（M:N，多线程） |
| **多核利用** | ❌ 单线程，需要多进程 | ✅ 原生多核 |
| **I/O 处理** | await + 异步驱动 | 直接写同步代码，运行时处理 |
| **CPU 密集** | 需要进程池绕过 GIL | 直接 goroutine，天然并行 |
| **代码风格** | 需要 async/await 标记 | 看起来像同步代码 |
| **通信方式** | asyncio.Queue / 共享变量 | channel / sync |
| **适用场景** | I/O 密集型 Web 服务 | 什么都可以，尤其是系统级 |

代码锁住的根本原因几乎都是：**在一种并发模型里，用了属于另一种并发模型的操作**。

Python asyncio 里调了同步阻塞 → 卡死事件循环。  
多线程里忘了加锁 → 竞态条件。  
Go 里 goroutine 等 channel，但没人发送 → goroutine 泄漏。

搞清楚你用的是哪种模型，就能定位 90% 的并发问题。
