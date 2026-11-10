package codex

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func ShutdownSignals() []os.Signal {
	return []os.Signal{syscall.SIGTERM}
}

// Start suspended so the server cannot spawn tools before joining the job.
// Closing the launcher's non-inherited job handle kills the entire tree,
// including when Windows terminates the launcher without running cleanup.
func startCodexAppServerProcess(command *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create Codex process job: %w", err)
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { _ = windows.CloseHandle(job) }) }
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		cleanup()
		return nil, fmt.Errorf("configure Codex process job: %w", err)
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_SUSPENDED}
	ready := make(chan struct{})
	command.Cancel = func() error {
		<-ready
		cleanup()
		return command.Process.Kill()
	}
	command.WaitDelay = 2 * time.Second
	if err = command.Start(); err != nil {
		close(ready)
		cleanup()
		return nil, err
	}
	err = attachAndResumeCodex(command.Process.Pid, job)
	close(ready)
	if err != nil {
		cleanup()
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	return cleanup, nil
}

func attachAndResumeCodex(pid int, job windows.Handle) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if err = windows.AssignProcessToJobObject(job, process); err != nil {
		return fmt.Errorf("assign Codex process job: %w", err)
	}
	// os/exec closes CreateProcess's initial thread handle. Locate that thread
	// while it is still suspended; no other server threads can exist yet.
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		_ = windows.CloseHandle(thread)
		return err
	}
	return fmt.Errorf("find suspended Codex thread: %w", err)
}
