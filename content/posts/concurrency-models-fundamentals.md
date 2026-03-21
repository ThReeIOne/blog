---
title: "并发模型全景图（一）：进程、线程、协程、异步到底是什么"
date: "2026-03-20"
tags: ["架构"]
summary: "代码为什么会锁住？因为你不清楚当前用的是哪种并发模型。这篇文章从操作系统层面拆解进程、线程、协程、异步 I/O 的本质区别，搞清楚这些概念，才能真正理解为什么 FastAPI 用 async/await，Go 用 goroutine，Python 多线程跑不快。"
---

写了一段时间后端代码，你一定遇到过这种情况：调一个接口，程序卡死了；加了个锁，死锁了；改成异步，结果更乱了。

根本原因通常不是代码写错了，而是**你用的并发模型和你以为的不一样**。

这篇文章从操作系统层面讲清楚四个核心概念：进程、线程、协程、异步 I/O。理解它们的本质，才能理解为什么 FastAPI 要写 `async def`，Go 的 goroutine 为什么那么轻，Python 多线程跑不快的真正原因是什么。

---

## 一切从 CPU 和 I/O 的矛盾说起

现代程序做的事情大体上分两类：

- **CPU 密集型（CPU-bound）**：大量计算，比如加密、图像处理、机器学习训练。瓶颈在 CPU。
- **I/O 密集型（I/O-bound）**：大量等待，比如读数据库、调 HTTP 接口、读文件。瓶颈在等待。

典型的 Web 服务几乎都是 I/O 密集型——一个请求进来，查数据库（等 50ms）、调外部 API（等 200ms）、写缓存（等 5ms），CPU 真正忙的时间可能只有 1ms，剩下 254ms 都在等。

**并发问题的核心矛盾就是：等待的时候，CPU 在干什么？**

- 什么都不干（同步阻塞）→ 浪费
- 切换去做别的事 → 需要机制来管理"切换"

进程、线程、协程、异步 I/O，本质上都是对"切换"这件事的不同解法。

---

## 进程（Process）

### 是什么

进程是操作系统分配资源的最小单位。启动一个程序，操作系统就创建一个进程，给它分配：

- 独立的虚拟地址空间（内存）
- 文件描述符表
- 信号处理
- 至少一个线程（主线程）

进程之间的内存完全隔离，进程 A 崩溃不会影响进程 B。

### 多进程并发

要同时处理多个任务，最简单的方式是 fork 多个进程：

```
请求 A → 进程 1 (PID: 100)  ─── 独立内存
请求 B → 进程 2 (PID: 101)  ─── 独立内存
请求 C → 进程 3 (PID: 102)  ─── 独立内存
```

**优点：**
- 隔离性强，一个进程崩了不影响其他
- 可以充分利用多核 CPU（每个进程分配到不同核）
- 不需要考虑共享状态的同步问题（内存隔离）

**缺点：**
- 创建进程代价高（fork 需要复制大量状态）
- 内存占用大（每个进程独立内存空间，动辄几十 MB）
- 进程间通信（IPC）复杂（管道、Socket、共享内存）
- 上下文切换开销大（内核需要保存/恢复完整进程状态）

### 谁在用

- **Nginx**：Master 进程 + 多个 Worker 进程
- **PostgreSQL**：每个连接一个后台进程
- **Gunicorn**：Python WSGI 服务器，多进程模型
- **Chrome**：每个 Tab 一个进程（为了隔离崩溃）

---

## 线程（Thread）

### 是什么

线程是 CPU 调度的最小单位，是进程内的执行单元。一个进程可以有多个线程，这些线程：

- **共享**进程的内存空间（全局变量、堆）
- **独享**自己的栈（局部变量）、寄存器状态、程序计数器

```
进程（共享内存空间）
├── 线程 1: 栈 + 寄存器
├── 线程 2: 栈 + 寄存器
└── 线程 3: 栈 + 寄存器
```

### 多线程并发

```python
import threading

shared_counter = 0  # 共享变量

def increment():
    global shared_counter
    for _ in range(100000):
        shared_counter += 1  # 危险！不是原子操作

t1 = threading.Thread(target=increment)
t2 = threading.Thread(target=increment)
t1.start(); t2.start()
t1.join(); t2.join()

print(shared_counter)  # 不一定是 200000！可能是 137482 之类的随机数
```

这就是**竞态条件（Race Condition）**——两个线程同时读到 `shared_counter = 100`，分别加 1 写回 `101`，实际上只增加了 1 而不是 2。

解决方式是加锁：

```python
lock = threading.Lock()

def increment_safe():
    global shared_counter
    for _ in range(100000):
        with lock:  # 同一时刻只有一个线程能进入
            shared_counter += 1
```

**优点：**
- 比进程轻，创建和切换代价小
- 共享内存，通信方便
- 可以利用多核 CPU

**缺点：**
- 共享内存带来的同步问题（锁、死锁、竞态条件）
- 线程切换仍然有开销（内核调度）
- 一个线程崩溃可能导致整个进程崩溃

### Python 的特殊问题：GIL

Python 有个臭名昭著的 **GIL（Global Interpreter Lock，全局解释器锁）**。

CPython（最常用的 Python 实现）的内存管理不是线程安全的，所以用一把全局锁来保证同一时刻只有一个线程在执行 Python 字节码：

```
时间线:
线程1: [执行字节码] → [释放GIL] → [等待GIL]→→→→→→ [执行字节码]
线程2: [等待GIL]→→→→→→→→→→→ [执行字节码] → [释放GIL]
```

**结果：Python 的多线程无法真正并行执行 CPU 密集型任务。**

```python
import time, threading

def cpu_task():
    count = 0
    for _ in range(50_000_000):
        count += 1

# 单线程
start = time.time()
cpu_task()
cpu_task()
print(f"单线程: {time.time() - start:.2f}s")  # ~4.2s

# 双线程（你以为会快 2 倍）
start = time.time()
t1 = threading.Thread(target=cpu_task)
t2 = threading.Thread(target=cpu_task)
t1.start(); t2.start()
t1.join(); t2.join()
print(f"双线程: {time.time() - start:.2f}s")  # ~4.5s，甚至更慢！
```

**但是**，GIL 在 I/O 等待期间会释放：

```python
import time, threading, requests

def fetch(url):
    requests.get(url)  # 网络 I/O 期间释放 GIL

# 多线程爬取是有效的！
urls = ["https://example.com"] * 10
threads = [threading.Thread(target=fetch, args=(url,)) for url in urls]
for t in threads: t.start()
for t in threads: t.join()
# 比顺序执行快很多，因为等待网络的时候其他线程可以运行
```

**结论：Python 多线程适合 I/O 密集型，不适合 CPU 密集型。CPU 密集型用多进程（multiprocessing）。**

---

## 协程（Coroutine）

### 是什么

协程是一种**用户态的轻量级并发**，不依赖操作系统的线程/进程调度，由程序自己控制切换。

关键特征：**协程主动让出控制权**，而不是被操作系统强制切换。

```
线程切换：操作系统在任意时刻可以抢占线程，保存状态，切换到另一个线程
协程切换：协程必须显式调用 yield/await，主动把控制权交出去
```

这个区别非常重要：
- 线程切换是**抢占式**的（preemptive），你不知道什么时候被打断
- 协程切换是**协作式**的（cooperative），你决定什么时候让出

### 协程为什么轻

一个操作系统线程的栈默认是 1-8MB（Linux 默认 8MB）。一万个线程就需要 80GB 内存，不现实。

协程的栈初始只有几 KB（Go 的 goroutine 初始 8KB），可以动态增长。一百万个协程完全没问题。

而且协程切换发生在用户态，不需要陷入内核，切换开销是线程的 10-100 倍以下。

### Python 的协程：async/await

```python
import asyncio

async def fetch_data(name, delay):
    print(f"{name}: 开始请求")
    await asyncio.sleep(delay)  # 模拟 I/O 等待，主动让出控制权
    print(f"{name}: 请求完成")
    return f"{name} 的数据"

async def main():
    # 并发执行三个协程
    results = await asyncio.gather(
        fetch_data("用户A", 1.0),
        fetch_data("用户B", 0.5),
        fetch_data("用户C", 0.8),
    )
    print(results)

asyncio.run(main())

# 输出：
# 用户A: 开始请求
# 用户B: 开始请求
# 用户C: 开始请求
# 用户B: 请求完成   ← 0.5s 后
# 用户C: 请求完成   ← 0.8s 后
# 用户A: 请求完成   ← 1.0s 后
# 总耗时约 1s，不是 2.3s
```

**关键理解：`await` 就是"我要等了，你去做别的吧"。**

在 `await asyncio.sleep(delay)` 的时候，当前协程挂起，事件循环（Event Loop）去运行其他协程。等 sleep 结束，事件循环再回来继续这个协程。

### 协程的陷阱：不能阻塞

协程只有一个线程在跑，如果你在协程里调用了阻塞操作，整个程序就卡死了：

```python
import asyncio, time

async def bad():
    print("开始")
    time.sleep(2)  # 错误！这是同步阻塞，会卡住整个事件循环
    print("结束")

async def other():
    await asyncio.sleep(0)  # 让出控制权
    print("我永远不会在 bad() 睡觉期间运行")

async def main():
    await asyncio.gather(bad(), other())
```

**在 async 函数里，任何同步阻塞调用都会卡死整个事件循环。**

这就是为什么 FastAPI 里不能直接用 `time.sleep()`，要用 `asyncio.sleep()`；不能用普通的 `requests`，要用 `httpx`（支持 async）或 `aiohttp`。

---

## 异步 I/O（Async I/O）

### I/O 的本质

程序做 I/O（读文件、网络请求、数据库查询），最终都要通过系统调用让操作系统去做：

```
程序 → 系统调用 read() → 操作系统 → 硬件（网卡/磁盘）
```

**阻塞 I/O（Blocking I/O）**：

```
程序调用 read() → 线程阻塞，什么都不做 → 数据到了 → 线程恢复
```

线程在等待期间完全挂起，CPU 可以去运行其他线程，但切换有开销。

**非阻塞 I/O（Non-blocking I/O）**：

```
程序调用 read() → 立即返回（可能是"数据还没好"） → 程序做别的 → 过一会儿再试
```

程序不阻塞，但需要反复轮询（polling），低效。

**I/O 多路复用（I/O Multiplexing）**：

这是异步 I/O 的核心机制。`select/poll/epoll`（Linux）、`kqueue`（macOS/BSD）允许一个线程同时监听多个 I/O 事件：

```
一个线程：
    告诉操作系统："帮我盯着这 1000 个 socket，哪个有数据了通知我"
    事件循环等待
    某个 socket 有数据了 → 操作系统通知 → 事件循环处理这个事件 → 继续等待
```

**epoll 是 Linux 异步 I/O 的核心**，asyncio、Node.js、Nginx 底层都是用它。

### 事件循环（Event Loop）

异步框架的核心是事件循环，它就像一个调度员：

```
事件循环不断循环：
    1. 有没有可以立即执行的协程？ → 执行它
    2. 有没有 I/O 事件就绪？ → 唤醒等待这个 I/O 的协程
    3. 有没有定时器到期？ → 唤醒对应的协程
    4. 都没有 → 阻塞等待（epoll_wait），直到有事件发生
```

```python
# 简化版事件循环伪代码
class EventLoop:
    def __init__(self):
        self.ready = []      # 可以立即运行的协程
        self.io_waiting = {} # 等待 I/O 的协程
        self.timers = []     # 定时器

    def run(self):
        while True:
            # 1. 运行所有就绪的协程
            while self.ready:
                coro = self.ready.pop(0)
                coro.send(None)  # 运行到下一个 await

            # 2. 检查 I/O 事件（epoll_wait）
            events = epoll.poll(timeout=next_timer_delay())
            for fd, event in events:
                coro = self.io_waiting.pop(fd)
                self.ready.append(coro)  # 加入就绪队列

            # 3. 检查到期的定时器
            # ...
```

---

## 四个模型的本质对比

```
多进程：
    [进程1: 线程] [进程2: 线程] [进程3: 线程]
    各自独立内存，操作系统调度，重但稳

多线程：
    [进程: 线程1  线程2  线程3]
         ↑共享内存↑
    操作系统调度，轻于进程，需要锁

协程（单线程）：
    [进程: 线程: 协程1 → 协程2 → 协程3]
    用户态调度，极轻，await 主动切换

协程（多线程）：Go goroutine 模型：
    [进程: 线程1(goroutine×N)  线程2(goroutine×N)]
    用户态调度 + 多核，两全其美
```

| 维度 | 多进程 | 多线程 | 协程（单线程）| Go goroutine |
|------|--------|--------|--------------|--------------|
| 调度者 | 操作系统 | 操作系统 | 程序自己 | Go 运行时 |
| 内存隔离 | 是 | 否 | 否 | 否 |
| 共享状态 | 需要 IPC | 需要锁 | 需要锁（但冲突少）| 需要锁 |
| 单位开销 | 高（MB） | 中（MB） | 极低（KB） | 极低（KB） |
| 利用多核 | 是 | 是 | 否 | 是 |
| 代码复杂度 | 中 | 高 | 中（需要 async/await）| 低 |

---

## 代码锁住的常见原因

理解了这些概念，再回头看"代码锁住"的情况：

**1. 在异步代码里调用了同步阻塞**
```python
# 错误：卡死事件循环
async def handler():
    data = requests.get("https://api.example.com")  # 同步阻塞！

# 正确
async def handler():
    async with httpx.AsyncClient() as client:
        data = await client.get("https://api.example.com")
```

**2. 死锁（DeadLock）**
```python
lock_a = threading.Lock()
lock_b = threading.Lock()

def thread1():
    with lock_a:
        time.sleep(0.1)
        with lock_b:  # 等 lock_b，但 thread2 拿着 lock_b 在等 lock_a
            pass

def thread2():
    with lock_b:
        time.sleep(0.1)
        with lock_a:  # 等 lock_a，但 thread1 拿着 lock_a 在等 lock_b
            pass
# 两个线程互相等待，永远不会结束
```

**3. 混用同步和异步**
```python
# 在同步函数里调用异步函数，错误姿势
def sync_function():
    result = async_function()  # 返回的是 coroutine 对象，不是结果！
    
# 正确姿势
def sync_function():
    result = asyncio.run(async_function())  # 如果外层没有事件循环
```

**4. 数据库连接池耗尽**
```python
# 协程里每次都新建连接，连接池满了，所有协程都在等连接
async def handler():
    conn = await pool.acquire()  # 等待可用连接，如果池子满了就永久等待
    # ... 操作完没有 release！
    # 连接泄漏，池子很快耗尽
    
# 正确：用 async with 自动释放
async def handler():
    async with pool.acquire() as conn:
        # 操作完自动 release
```

---

下一篇：[FastAPI 的并发模型：async/await 在 Web 框架里怎么用](./concurrency-fastapi.md)
