package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	appName = "whatsapp-mcp-local"
	baseURL = "http://localhost:7865"
	daemon  = "system/com.whatsapp-mcp.local"
)

type health struct {
	App      string `json:"app"`
	State    string `json:"state"`
	Instance string `json:"instance"`
	WhatsApp string `json:"whatsapp"`
}

type controlResponse struct {
	Error   string `json:"error"`
	Command string `json:"startCommand"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	root := filepath.Dir(filepath.Dir(executable))
	data := filepath.Join(root, "data")
	if len(os.Args) == 2 && os.Args[1] == "stdio" {
		return relayStdio(filepath.Join(data, "run", "mcp.sock"), executable)
	}
	if os.Geteuid() == 0 {
		return errors.New("run this command as the macOS user selected at setup")
	}
	if len(os.Args) == 3 && os.Args[1] == "start" && os.Args[2] == "--no-browser" {
		return start(data)
	}
	if len(os.Args) == 2 {
		switch os.Args[1] {
		case "start":
			if err := start(data); err != nil {
				return err
			}
			return openDashboard()
		case "stop", "restart":
			return control(os.Args[1], data)
		case "status":
			return status(data)
		case "disable-boot": // Invoked by the installed Node process.
			return withStateLock(data, func() error { return setEnabled(data, false) })
		}
	}
	return errors.New("usage: whatsapp-mcp {start [--no-browser]|stop|restart|status|stdio}")
}

func relayStdio(path, executable string) error {
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return fmt.Errorf("WhatsApp MCP is unavailable. Start it with %q start", executable)
	}
	defer conn.Close()
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		_ = conn.CloseWrite()
	}()
	_, err = io.Copy(os.Stdout, conn)
	return err
}

func marker(data string) string { return filepath.Join(data, "control", "enabled") }

func setEnabled(data string, enabled bool) error {
	path := marker(data)
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	if !enabled {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return directory.Sync()
	}

	temp, err := os.CreateTemp(filepath.Dir(path), ".enabled-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	syncErr := temp.Sync()
	closeErr := temp.Close()
	if err := errors.Join(syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return err
	}
	return directory.Sync()
}

func withStateLock(data string, action func() error) error {
	lock, err := os.OpenFile(filepath.Join(data, "control", "boot.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	return action()
}

func getHealth() (health, bool) {
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Get(baseURL + "/api/status")
	if err != nil {
		return health{}, false
	}
	defer response.Body.Close()
	var result health
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result)
	return result, err == nil && response.StatusCode == 200 && result.App == appName
}

func daemonRunning() bool {
	output, _ := exec.Command("/bin/launchctl", "print", daemon).Output()
	return strings.Contains(string(output), "state = running")
}

func start(data string) error {
	if state, ok := getHealth(); ok && state.State == "running" {
		return nil
	}
	// Obtain approval before changing the persistent state.
	if err := sudo("-v"); err != nil {
		return err
	}
	err := withStateLock(data, func() error {
		if state, ok := getHealth(); ok && state.State == "running" {
			return nil
		}
		if state, ok := getHealth(); ok && state.State == "stopping" {
			return errors.New("WhatsApp MCP is still stopping. Run start again when it finishes")
		}
		_, statErr := os.Stat(marker(data))
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
		if err := setEnabled(data, true); err != nil {
			return err
		}
		if err := sudo("-n", "/bin/launchctl", "kickstart", daemon); err != nil {
			if errors.Is(statErr, os.ErrNotExist) {
				return errors.Join(err, setEnabled(data, false))
			}
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	return waitForHealth("")
}

func status(data string) error {
	if state, ok := getHealth(); ok {
		fmt.Printf("Service: %s\nWhatsApp: %s\nDashboard: %s\n", state.State, state.WhatsApp, baseURL)
		return nil
	}
	if _, err := os.Stat(marker(data)); errors.Is(err, os.ErrNotExist) {
		fmt.Println("Stopped. Run whatsapp-mcp start to enable startup.")
		return nil
	} else if err != nil {
		return err
	}
	fmt.Println("Startup is enabled. The dashboard is unavailable. Check the app's data/logs folder.")
	return nil
}

func control(action, data string) error {
	old, running := getHealth()
	if !running && action == "stop" {
		if err := withStateLock(data, func() error { return setEnabled(data, false) }); err != nil {
			return err
		}
		if daemonRunning() {
			if err := sudo("/bin/launchctl", "kill", "SIGTERM", daemon); err != nil && daemonRunning() {
				return err
			}
			return waitForExit()
		}
		fmt.Println("Stopped.")
		return nil
	}
	if !running {
		return errors.New("WhatsApp MCP is unavailable. Run whatsapp-mcp start")
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/api/service/"+action, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Origin", baseURL)
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var result controlResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result); err != nil {
		return err
	}
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("%s failed: %s", action, result.Error)
	}
	if action == "restart" {
		return waitForHealth(old.Instance)
	}
	if err := waitForExit(); err != nil {
		return err
	}
	fmt.Printf("Stopped. Start with: %s\n", result.Command)
	return nil
}

func waitForExit() error {
	for deadline := time.Now().Add(25 * time.Second); time.Now().Before(deadline); {
		if !daemonRunning() {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("the stop was saved, but the daemon has not exited yet")
}

func waitForHealth(previous string) error {
	for deadline := time.Now().Add(35 * time.Second); time.Now().Before(deadline); {
		if state, ok := getHealth(); ok && state.State == "running" && state.Instance != previous {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return errors.New("the dashboard did not become ready. Check the app's data/logs folder")
}

func openDashboard() error {
	fmt.Println("WhatsApp MCP dashboard:", baseURL)
	return exec.Command("/usr/bin/open", baseURL).Run()
}

func sudo(args ...string) error {
	command := exec.Command("/usr/bin/sudo", args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stderr, os.Stderr
	return command.Run()
}
